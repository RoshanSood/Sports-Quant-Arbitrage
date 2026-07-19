// Per-request on-chain wallet credentials forwarded from the user's browser (entered in
// the Venue drawer, kept in localStorage — never persisted server-side). Wallet keys are
// base64-encoded in transit so they aren't recognizable in header dumps. These are read,
// used transiently to sign, and discarded — never logged, never written to disk, never
// returned to the client.

// Unified Polymarket creds carrying BOTH region shapes (only one set is used per region):
//   • intl (self-custody CLOB): wallet private key + optional funder/sigType
//   • us   (regulated):         Ed25519 Key ID + secret
export type PolymarketCreds = { key?: string; funder?: string; sigType?: number; keyId?: string; secret?: string };
export type SxbetCreds = { key: string };
export type OnchainCreds = { polymarket?: PolymarketCreds; sxbet?: SxbetCreds };

function decodeKey(b64: string | null): string | undefined {
  if (!b64) return undefined;
  try {
    const s = Buffer.from(b64, "base64").toString("utf-8").trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

function numOrUndef(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function extractOnchainCredsFromHeaders(headers: Headers): OnchainCreds {
  const out: OnchainCreds = {};
  const poly: PolymarketCreds = {};
  // intl (self-custody): base64 wallet key + optional funder/sigType.
  const walletKey = decodeKey(headers.get("x-polymarket-key"));
  if (walletKey) {
    poly.key = walletKey;
    poly.funder = headers.get("x-polymarket-funder")?.trim() || undefined;
    poly.sigType = numOrUndef(headers.get("x-polymarket-sig-type"));
  }
  // us (regulated): Key ID (plain) + base64 Ed25519 secret.
  const keyId = headers.get("x-polymarket-key-id")?.trim();
  const secret = decodeKey(headers.get("x-polymarket-secret"));
  if (keyId && secret) {
    poly.keyId = keyId;
    poly.secret = secret;
  }
  if (poly.key || poly.keyId) out.polymarket = poly;
  const sxKey = decodeKey(headers.get("x-sxbet-key"));
  if (sxKey) out.sxbet = { key: sxKey };
  return out;
}
