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

// Standard PKCS8 prefix for an Ed25519 private key carrying a 32-byte seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function seedToKey(seed: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

// Build an Ed25519 private KeyObject from the portal secret, tolerant of every common
// encoding a developer portal might hand out:
//   • PEM ("-----BEGIN PRIVATE KEY-----")
//   • base64 / base64url of: a raw 32-byte seed, a 48-byte PKCS8 DER, or a 64-byte
//     libsodium secret key (seed ‖ public key — take the first 32 as the seed)
//   • hex of the same, as a fallback
function ed25519Key(secret: string): crypto.KeyObject {
  const s = secret.trim();
  if (s.includes("-----BEGIN")) return crypto.createPrivateKey({ key: s, format: "pem" });

  let buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  // Fall back to hex if base64 didn't yield an Ed25519-plausible length.
  if (![32, 48, 64].includes(buf.length) && /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    const hex = Buffer.from(s, "hex");
    if ([32, 48, 64].includes(hex.length)) buf = hex;
  }

  if (buf.length === 32) return seedToKey(buf); // raw seed
  if (buf.length === 64) return seedToKey(buf.subarray(0, 32)); // libsodium secretKey (seed ‖ pub)
  if (buf.length === 48) return crypto.createPrivateKey({ key: buf, format: "der", type: "pkcs8" }); // PKCS8 DER
  try {
    return crypto.createPrivateKey({ key: buf, format: "der", type: "pkcs8" });
  } catch {
    throw new Error(`unrecognized Ed25519 secret format (decoded ${buf.length} bytes; expected 32 seed / 48 pkcs8 / 64 libsodium)`);
  }
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
