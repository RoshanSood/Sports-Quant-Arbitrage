// Polymarket US authenticated request signing (docs: api-reference/authentication).
// Auth is a per-request Ed25519 signature — NOT a wallet key, NOT JWT. Credentials are a
// Key ID + a base64 Ed25519 secret from the developer portal. Each request sends:
//   X-PM-Access-Key: <keyId>
//   X-PM-Timestamp:  <ms since epoch>
//   X-PM-Signature:  base64( Ed25519_sign( `${timestamp}${METHOD}${path}` ) )
// Credentials are read from the browser (per-request) or server env; used transiently to
// sign, never persisted or logged.

import crypto from "node:crypto";

export const PMUS_API = "https://api.polymarket.us";

export type PolymarketUsCreds = { keyId: string; secret: string };

export function pmusCreds(override?: PolymarketUsCreds): PolymarketUsCreds | null {
  const keyId = override?.keyId?.trim() || process.env.POLYMARKET_US_KEY_ID?.trim();
  const secret = override?.secret?.trim() || process.env.POLYMARKET_US_SECRET?.trim();
  return keyId && secret ? { keyId, secret } : null;
}

export function hasPmusCreds(override?: PolymarketUsCreds): boolean {
  return pmusCreds(override) != null;
}

// Build an Ed25519 private KeyObject from the base64 secret. Handles either a raw 32-byte
// seed (wrapped in the standard PKCS8 header) or an already-DER/PKCS8-encoded key.
function ed25519Key(secretB64: string): crypto.KeyObject {
  const raw = Buffer.from(secretB64, "base64");
  if (raw.length === 32) {
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]);
    return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  }
  return crypto.createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
}

// Exported for unit testing the signing scheme deterministically.
export function signMessage(secretB64: string, message: string): string {
  // Ed25519 uses algorithm=null in Node's one-shot sign.
  return crypto.sign(null, Buffer.from(message, "utf-8"), ed25519Key(secretB64)).toString("base64");
}

export function authHeaders(creds: PolymarketUsCreds, method: string, path: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const signature = signMessage(creds.secret, `${timestamp}${method.toUpperCase()}${path}`);
  return {
    "X-PM-Access-Key": creds.keyId,
    "X-PM-Timestamp": timestamp,
    "X-PM-Signature": signature,
  };
}

// Signed request to the authenticated API. `path` starts with "/v1/…".
export async function pmusFetch<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  creds: PolymarketUsCreds,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  try {
    const res = await fetch(`${PMUS_API}${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...authHeaders(creds, method, path),
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      // non-JSON error body
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e).slice(0, 200) };
  }
}

type BalancesResponse = { balances?: Array<{ currentBalance?: string; buyingPower?: string; currency?: string }> };

// USD buying power for the account (used by verification + the balance readout).
export async function pmusBuyingPower(creds: PolymarketUsCreds): Promise<{ ok: boolean; buyingPower: number | null; error?: string }> {
  const r = await pmusFetch<BalancesResponse>("GET", "/v1/account/balances", creds);
  if (!r.ok || !r.data) return { ok: false, buyingPower: null, error: r.error ?? `HTTP ${r.status}` };
  const usd = (r.data.balances ?? []).find((b) => (b.currency ?? "USD").toUpperCase() === "USD") ?? r.data.balances?.[0];
  const bp = Number(usd?.buyingPower ?? usd?.currentBalance);
  return { ok: true, buyingPower: Number.isFinite(bp) ? bp : null };
}
