import crypto from "node:crypto";

const BASE_URL =
  process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

const PATH_PREFIX = "/trade-api/v2";

export type KalshiHeaders = Record<string, string>;

// Explicit credentials passed per-request (override env vars)
export type KalshiCreds = { keyId: string; privateKey: string };

function loadPrivateKey(creds?: KalshiCreds): string | null {
  const raw = creds?.privateKey ?? process.env.KALSHI_PRIVATE_KEY;
  if (!raw) return null;
  // Support both literal newlines and \n-escaped env values
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function signPath(
  method: string,
  path: string,
  timestamp: string,
  creds?: KalshiCreds
): string | null {
  const pem = loadPrivateKey(creds);
  const keyId = creds?.keyId ?? process.env.KALSHI_KEY_ID;
  if (!pem || !keyId) return null;

  const msg = Buffer.from(timestamp + method.toUpperCase() + path);
  const sig = crypto.sign("sha256", msg, {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}

function authHeaders(
  method: string,
  path: string,
  creds?: KalshiCreds
): KalshiHeaders {
  const timestamp = Date.now().toString();
  const signature = signPath(method, path, timestamp, creds);
  const keyId = creds?.keyId ?? process.env.KALSHI_KEY_ID;
  if (!signature || !keyId) return {};
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

// Public market-data calls work without auth; we still send headers when configured
// so the request gets logged against the user's account quota.
export async function kalshiGet<T = unknown>(
  pathWithQuery: string,
  // `revalidate` is accepted for API compatibility but ignored — we skip the
  // Next.js data cache so we don't trip its 2MB limit on large event responses.
  _options: { revalidate?: number } = {},
  creds?: KalshiCreds
): Promise<T> {
  // The signature must NOT include the query string. Split it off before signing.
  const queryIdx = pathWithQuery.indexOf("?");
  const pathOnly = queryIdx === -1 ? pathWithQuery : pathWithQuery.slice(0, queryIdx);
  const fullPath = `${PATH_PREFIX}${pathOnly}`;
  const headers: KalshiHeaders = {
    Accept: "application/json",
    ...authHeaders("GET", fullPath, creds),
  };

  const url = `${BASE_URL}${pathWithQuery}`;
  const res = await fetch(url, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function kalshiPost<T = unknown>(
  path: string,
  body: unknown,
  creds?: KalshiCreds
): Promise<T> {
  const fullPath = `${PATH_PREFIX}${path}`;
  const headers: KalshiHeaders = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...authHeaders("POST", fullPath, creds),
  };

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function kalshiDelete<T = unknown>(path: string, creds?: KalshiCreds): Promise<T> {
  const fullPath = `${PATH_PREFIX}${path}`;
  const headers: KalshiHeaders = {
    Accept: "application/json",
    ...authHeaders("DELETE", fullPath, creds),
  };
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// True when creds are provided per-call OR configured in the environment.
export function isKalshiConfigured(creds?: KalshiCreds): boolean {
  if (creds?.keyId && creds?.privateKey) return true;
  return Boolean(process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
}

// Extract user-supplied credentials forwarded from the browser via request headers.
// The private key is base64-encoded for safe transport.
export function extractCredsFromHeaders(headers: Headers): KalshiCreds | undefined {
  const keyId = headers.get("x-kalshi-key-id");
  const privateKeyB64 = headers.get("x-kalshi-private-key");
  if (!keyId || !privateKeyB64) return undefined;
  try {
    const privateKey = Buffer.from(privateKeyB64, "base64").toString("utf-8");
    return { keyId, privateKey };
  } catch {
    return undefined;
  }
}
