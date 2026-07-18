// Credential + wallet verification (manual §2 phase 2, §19). Produces a balance/
// allowance/identity snapshot per venue WITHOUT placing any order — this is how you
// confirm your funded wallets connect before order code is ever enabled. All reads;
// no signing, no orders.

import { isKalshiConfigured, kalshiGet, type KalshiCreds } from "@/lib/kalshiAuth";
import { SX_CHAIN_ID } from "./chains";
import type { OnchainCreds, SxbetCreds } from "./onchainCreds";
import { pmusBuyingPower, pmusCreds, type PolymarketUsCreds } from "./polymarketUsAuth";
import { getSxMetadata } from "./sxMeta";
import { deriveEoa, hasWalletKey, providerFor, usdcAllowance, usdcBalance } from "./wallet";

export type VenueVerification = {
  venueId: "kalshi" | "polymarket" | "sxbet";
  configured: boolean; // credential/key present server-side
  address: string | null; // EOA (wallet venues) — masked identity
  chainId: number | null;
  usdcBalance: number | null; // USD
  allowance: number | null; // USDC spending allowance (wallet venues that need it)
  spender: string | null; // allowance spender (SX transfer proxy)
  status: "missing" | "verified" | "no_balance" | "needs_allowance" | "error";
  message?: string;
};

export async function verifyKalshi(creds?: KalshiCreds): Promise<VenueVerification> {
  const base: VenueVerification = {
    venueId: "kalshi",
    configured: isKalshiConfigured(creds),
    address: null,
    chainId: null,
    usdcBalance: null,
    allowance: null,
    spender: null,
    status: "missing",
  };
  if (!base.configured) return base;
  try {
    const b = await kalshiGet<{ balance?: number }>("/portfolio/balance", {}, creds);
    const bal = typeof b.balance === "number" ? b.balance / 100 : null;
    return { ...base, usdcBalance: bal, status: bal && bal > 0 ? "verified" : "no_balance" };
  } catch (e) {
    return { ...base, status: "error", message: String(e).slice(0, 160) };
  }
}

// Polymarket US verification — a SIGNED account-balances read confirms the Key ID +
// Ed25519 secret actually work and shows USD buying power. No wallet/on-chain.
export async function verifyPolymarket(creds?: PolymarketUsCreds): Promise<VenueVerification> {
  const c = pmusCreds(creds);
  const base: VenueVerification = {
    venueId: "polymarket",
    configured: c != null,
    address: c ? c.keyId : null, // Key ID (masked by the status route before leaving the server)
    chainId: null,
    usdcBalance: null,
    allowance: null,
    spender: null,
    status: "missing",
  };
  if (!c) return base;
  const r = await pmusBuyingPower(c);
  if (!r.ok) return { ...base, status: "error", message: `Polymarket US auth/balance failed: ${r.error ?? "unknown"}` };
  return { ...base, usdcBalance: r.buyingPower, status: (r.buyingPower ?? 0) > 0 ? "verified" : "no_balance" };
}

export async function verifySx(creds?: SxbetCreds): Promise<VenueVerification> {
  const base: VenueVerification = {
    venueId: "sxbet",
    configured: hasWalletKey("sxbet", creds?.key),
    address: null,
    chainId: SX_CHAIN_ID,
    usdcBalance: null,
    allowance: null,
    spender: null,
    status: "missing",
  };
  if (!base.configured) return base;
  const eoa = deriveEoa("sxbet", creds?.key);
  if (!eoa) return { ...base, status: "error", message: "invalid SX.bet wallet key" };
  const meta = await getSxMetadata();
  if (!meta?.usdcAddress) return { ...base, address: eoa, status: "error", message: "SX /metadata missing USDC address" };
  const spender = meta.tokenTransferProxy ?? meta.executorAddress;
  try {
    const provider = providerFor("sxbet");
    const bal = await usdcBalance(provider, meta.usdcAddress, eoa);
    const allow = spender ? await usdcAllowance(provider, meta.usdcAddress, eoa, spender) : null;
    let status: VenueVerification["status"] = "verified";
    if (bal <= 0) status = "no_balance";
    else if (allow != null && allow <= 0) status = "needs_allowance";
    return { ...base, address: eoa, usdcBalance: bal, allowance: allow, spender, status };
  } catch (e) {
    return { ...base, address: eoa, spender, status: "error", message: `SX RPC/USDC read failed: ${String(e).slice(0, 120)}` };
  }
}

export async function verifyAllVenues(
  creds?: { kalshiCreds?: KalshiCreds } & OnchainCreds
): Promise<VenueVerification[]> {
  return Promise.all([
    verifyKalshi(creds?.kalshiCreds),
    verifyPolymarket(creds?.polymarket),
    verifySx(creds?.sxbet),
  ]);
}
