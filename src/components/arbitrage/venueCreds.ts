// Client-side venue credential storage. Credentials are entered in the Venue drawer and
// kept ONLY in this browser's localStorage — they are never persisted on the server. They
// ride on requests as headers (wallet keys base64-encoded), where the server uses them
// transiently to sign and then discards them. Nothing here is ever sent back from the
// server or logged.

export const KALSHI_CREDS_KEY = "kalshi_api_creds";
export const POLY_CREDS_KEY = "polymarket_wallet_creds";
export const SX_CREDS_KEY = "sxbet_wallet_creds";

export type PolyCreds = { key: string; funder?: string; sigType?: number };
export type SxCreds = { key: string };

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
}

export function loadVenueCreds(venueId: string): PolyCreds | SxCreds | null {
  if (venueId === "polymarket") return read<PolyCreds>(POLY_CREDS_KEY);
  if (venueId === "sxbet") return read<SxCreds>(SX_CREDS_KEY);
  return null;
}

export function saveVenueCreds(venueId: string, creds: PolyCreds | SxCreds): void {
  if (typeof window === "undefined") return;
  const key = venueId === "polymarket" ? POLY_CREDS_KEY : SX_CREDS_KEY;
  localStorage.setItem(key, JSON.stringify(creds));
}

export function clearVenueCreds(venueId: string): void {
  if (typeof window === "undefined") return;
  const key = venueId === "polymarket" ? POLY_CREDS_KEY : SX_CREDS_KEY;
  localStorage.removeItem(key);
}

// Headers carrying the on-chain wallet creds (base64 keys). Empty when none stored.
export function onchainAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const p = read<PolyCreds>(POLY_CREDS_KEY);
  if (p?.key) {
    h["x-polymarket-key"] = btoa(p.key);
    if (p.funder) h["x-polymarket-funder"] = p.funder;
    if (p.sigType != null) h["x-polymarket-sig-type"] = String(p.sigType);
  }
  const s = read<SxCreds>(SX_CREDS_KEY);
  if (s?.key) h["x-sxbet-key"] = btoa(s.key);
  return h;
}

export function kalshiAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const c = read<{ keyId?: string; privateKey?: string }>(KALSHI_CREDS_KEY);
  if (c?.keyId && c?.privateKey) {
    h["x-kalshi-key-id"] = c.keyId;
    h["x-kalshi-private-key"] = btoa(c.privateKey);
  }
  return h;
}

// All venue auth headers for an execution request.
export function allAuthHeaders(): Record<string, string> {
  return { ...kalshiAuthHeaders(), ...onchainAuthHeaders() };
}
