// Per-request on-chain wallet credentials forwarded from the user's browser (entered in
// the Venue drawer, kept in localStorage — never persisted server-side). Wallet keys are
// base64-encoded in transit so they aren't recognizable in header dumps. These are read,
// used transiently to sign, and discarded — never logged, never written to disk, never
// returned to the client.

import type { PolymarketUsCreds } from "./polymarketUsAuth";

export type PolymarketCreds = { key: string; funder?: string; sigType?: number };
export type SxbetCreds = { key: string };
// `polymarket` now carries Polymarket US API creds (Key ID + Ed25519 secret). The
// international wallet creds type is kept for the commented-out self-custody path.
export type OnchainCreds = { polymarket?: PolymarketUsCreds; sxbet?: SxbetCreds };

function decodeKey(b64: string | null): string | undefined {
  if (!b64) return undefined;
  try {
    const s = Buffer.from(b64, "base64").toString("utf-8").trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

export function extractOnchainCredsFromHeaders(headers: Headers): OnchainCreds {
  const out: OnchainCreds = {};
  // Polymarket US: Key ID (plain) + Ed25519 secret (base64-encoded in transit).
  const keyId = headers.get("x-polymarket-key-id")?.trim();
  const secret = decodeKey(headers.get("x-polymarket-secret"));
  if (keyId && secret) out.polymarket = { keyId, secret };
  const sxKey = decodeKey(headers.get("x-sxbet-key"));
  if (sxKey) out.sxbet = { key: sxKey };
  return out;
}
