// Client-side venue credential storage. Credentials are entered in the Venue drawer and
// kept ONLY in this browser's localStorage — they are never persisted on the server. They
// ride on requests as headers (wallet keys base64-encoded), where the server uses them
// transiently to sign and then discards them. Nothing here is ever sent back from the
// server or logged.

export const KALSHI_CREDS_KEY = "kalshi_api_creds";
export const POLY_CREDS_KEY = "polymarket_creds";
export const SX_CREDS_KEY = "sxbet_wallet_creds";
export const PF_CREDS_KEY = "predictfun_creds";

// predict.fun: x-api-key + wallet private key + (optional) ZeroDev smart-account address.
export type PfCreds = { apiKey?: string; walletKey?: string; account?: string };

// Polymarket creds carry either region's shape:
//   • intl: wallet private key (+ optional funder/sigType)
//   • us:   developer-portal Key ID + base64 Ed25519 secret
export type PolyCreds = { key?: string; funder?: string; sigType?: number; keyId?: string; secret?: string };
export type SxCreds = { key: string };

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
}

function keyForVenue(venueId: string): string {
  if (venueId === "polymarket") return POLY_CREDS_KEY;
  if (venueId === "predictfun") return PF_CREDS_KEY;
  return SX_CREDS_KEY;
}

export function loadVenueCreds(venueId: string): PolyCreds | SxCreds | PfCreds | null {
  if (venueId === "polymarket") return read<PolyCreds>(POLY_CREDS_KEY);
  if (venueId === "predictfun") return read<PfCreds>(PF_CREDS_KEY);
  if (venueId === "sxbet") return read<SxCreds>(SX_CREDS_KEY);
  return null;
}

export function saveVenueCreds(venueId: string, creds: PolyCreds | SxCreds | PfCreds): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(keyForVenue(venueId), JSON.stringify(creds));
  emitCredsChanged();
}

export function clearVenueCreds(venueId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(keyForVenue(venueId));
  emitCredsChanged();
}

// True when this browser has credentials stored for a venue (Kalshi API creds, or an
// on-chain wallet key). Drives the "connected" indicator on the arena nodes.
export function hasVenueCreds(venueId: string): boolean {
  if (typeof window === "undefined") return false;
  if (venueId === "kalshi") {
    const c = read<{ keyId?: string; privateKey?: string }>(KALSHI_CREDS_KEY);
    return Boolean(c?.keyId && c?.privateKey);
  }
  if (venueId === "polymarket") {
    const c = read<PolyCreds>(POLY_CREDS_KEY);
    return Boolean(c?.key || (c?.keyId && c?.secret)); // intl wallet key OR us keyId+secret
  }
  if (venueId === "predictfun") {
    const c = read<PfCreds>(PF_CREDS_KEY);
    return Boolean(c?.apiKey && c?.walletKey);
  }
  return Boolean(read<SxCreds>(SX_CREDS_KEY)?.key);
}

// Same-tab notification that stored creds changed (localStorage's own `storage` event
// only fires in OTHER tabs). Components re-read on this to stay in sync.
export const CREDS_CHANGED_EVENT = "arb-creds-changed";
export function emitCredsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CREDS_CHANGED_EVENT));
}

// Headers carrying venue creds. Polymarket intl: base64 wallet key (+ funder/sigType);
// Polymarket US: Key ID (plain) + base64 Ed25519 secret. SX.bet: base64 wallet key.
// Whatever is stored is sent; the server uses the set that matches its region.
export function onchainAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const p = read<PolyCreds>(POLY_CREDS_KEY);
  if (p?.key) {
    h["x-polymarket-key"] = btoa(p.key);
    if (p.funder) h["x-polymarket-funder"] = p.funder;
    if (p.sigType != null) h["x-polymarket-sig-type"] = String(p.sigType);
  }
  if (p?.keyId && p?.secret) {
    h["x-polymarket-key-id"] = p.keyId;
    h["x-polymarket-secret"] = btoa(p.secret);
  }
  const s = read<SxCreds>(SX_CREDS_KEY);
  if (s?.key) h["x-sxbet-key"] = btoa(s.key);
  // predict.fun: api key (plain) + base64 wallet key + optional smart-account address.
  const pf = read<PfCreds>(PF_CREDS_KEY);
  if (pf?.apiKey) h["x-predictfun-api-key"] = pf.apiKey;
  if (pf?.walletKey) h["x-predictfun-wallet-key"] = btoa(pf.walletKey);
  if (pf?.account) h["x-predictfun-account"] = pf.account;
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
