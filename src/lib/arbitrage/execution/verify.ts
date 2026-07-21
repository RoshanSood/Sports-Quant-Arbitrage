// Credential + wallet verification (manual §2 phase 2, §19). Produces a balance/
// allowance/identity snapshot per venue WITHOUT placing any order — this is how you
// confirm your funded wallets connect before order code is ever enabled. All reads;
// no signing, no orders.

import { Wallet } from "ethers";
import { isKalshiConfigured, kalshiGet, type KalshiCreds } from "@/lib/kalshiAuth";
import { polymarketRegion } from "@/lib/polymarketRegion";
import { BNB_CHAIN_ID, POLYGON_CHAIN_ID, SX_CHAIN_ID, polygonUsdcAddress } from "./chains";
import type { OnchainCreds, PolymarketCreds, SxbetCreds } from "./onchainCreds";
import { pmusBuyingPower, pmusCreds } from "./polymarketUsAuth";
import { pfAccount, pfApiKey, pfUsdtBalance, pfWalletKey } from "./predictFunAdapter";
import { cbApiKey, cbBalanceResult, cbCurrency } from "./cloudbetAdapter";
import type { CloudbetCreds, PredictFunCreds } from "./onchainCreds";
import { polymarketBalanceAllowance } from "./polymarketAdapter";
import { getSxMetadata } from "./sxMeta";
import { deriveEoa, hasWalletKey, providerFor, usdcAllowance, usdcBalance, walletKey } from "./wallet";

export type VenueVerification = {
  venueId: "kalshi" | "polymarket" | "sxbet" | "predictfun" | "cloudbet";
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

// Polymarket verification branches by region.
export async function verifyPolymarket(creds?: PolymarketCreds): Promise<VenueVerification> {
  return polymarketRegion() === "us" ? verifyPolymarketUs(creds) : verifyPolymarketIntl(creds);
}

// US: a SIGNED account-balances read confirms the Key ID + Ed25519 secret work + shows
// USD buying power. No wallet/on-chain.
async function verifyPolymarketUs(creds?: PolymarketCreds): Promise<VenueVerification> {
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

// intl (self-custody CLOB): derive the EOA from the wallet key and read USDC on Polygon.
async function verifyPolymarketIntl(creds?: PolymarketCreds): Promise<VenueVerification> {
  const base: VenueVerification = {
    venueId: "polymarket",
    configured: hasWalletKey("polymarket", creds?.key),
    address: null,
    chainId: POLYGON_CHAIN_ID,
    usdcBalance: null,
    allowance: null,
    spender: null,
    status: "missing",
  };
  if (!base.configured) return base;
  const eoa = deriveEoa("polymarket", creds?.key);
  if (!eoa) return { ...base, status: "error", message: "invalid Polymarket wallet key" };
  const owner = creds?.funder?.trim() || process.env.POLYMARKET_FUNDER?.trim() || eoa; // proxy wallets fund via a funder addr
  const key = walletKey("polymarket", creds?.key);
  if (key) {
    try {
      const ba = await polymarketBalanceAllowance(key, creds?.funder, creds?.sigType);
      if (!Number.isFinite(ba.balance)) throw new Error("invalid Polymarket balance response");
      let status: VenueVerification["status"] = "verified";
      if (ba.balance <= 0) status = "no_balance";
      else if (Number.isFinite(ba.allowance) && ba.allowance <= 0) status = "needs_allowance";
      return { ...base, address: eoa, usdcBalance: ba.balance, allowance: Number.isFinite(ba.allowance) ? ba.allowance : null, status };
    } catch {
      // Fall back to a direct on-chain read below for older EOA/proxy flows.
    }
  }
  try {
    const bal = await usdcBalance(providerFor("polymarket"), polygonUsdcAddress(), owner);
    return { ...base, address: eoa, usdcBalance: bal, status: bal > 0 ? "verified" : "no_balance" };
  } catch (e) {
    return { ...base, address: eoa, status: "error", message: `Polygon RPC/USDC read failed: ${String(e).slice(0, 120)}` };
  }
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

// predict.fun (BNB CLOB): confirm the API key + wallet key are present and read USDT
// buying power on BNB. Balance-only (no on-chain allowance shown — the SDK's setApprovals
// handles the ERC-1155/ERC-20 approvals separately).
export async function verifyPredictFun(creds?: PredictFunCreds): Promise<VenueVerification> {
  const base: VenueVerification = {
    venueId: "predictfun",
    configured: Boolean(pfApiKey(creds) && pfWalletKey(creds)),
    address: null,
    chainId: BNB_CHAIN_ID,
    usdcBalance: null,
    allowance: null,
    spender: null,
    status: "missing",
  };
  const key = pfWalletKey(creds);
  if (!base.configured || !key) return base;
  try {
    // Show the account that holds funds (smart account if set, else the signer).
    const owner = pfAccount(creds) ?? new Wallet(key).address;
    const bal = await pfUsdtBalance(owner);
    return { ...base, address: owner, usdcBalance: bal, status: (bal ?? 0) > 0 ? "verified" : "no_balance" };
  } catch (e) {
    return { ...base, status: "error", message: `predict.fun balance read failed: ${String(e).slice(0, 120)}` };
  }
}

// Cloudbet (crypto sportsbook): confirm the API key is present and read the settlement
// currency's account balance. Balance-only — a bet has no on-chain allowance, and books
// don't expose an order book. `address` carries the currency label (short strings pass the
// status route's masker unchanged) so the UI can show what the balance is denominated in.
export async function verifyCloudbet(creds?: CloudbetCreds): Promise<VenueVerification> {
  const key = cbApiKey(creds);
  const currency = cbCurrency(creds);
  const base: VenueVerification = {
    venueId: "cloudbet",
    configured: Boolean(key),
    address: currency,
    chainId: null,
    usdcBalance: null,
    allowance: null,
    spender: null,
    status: "missing",
  };
  if (!key) return base;
  const r = await cbBalanceResult(key, currency);
  if (!r.ok) return { ...base, status: "error", message: `Cloudbet balance read failed: ${r.detail}` };
  return { ...base, usdcBalance: r.amount, status: r.amount > 0 ? "verified" : "no_balance" };
}

export async function verifyAllVenues(
  creds?: { kalshiCreds?: KalshiCreds } & OnchainCreds
): Promise<VenueVerification[]> {
  return Promise.all([
    verifyKalshi(creds?.kalshiCreds),
    verifyPolymarket(creds?.polymarket),
    verifySx(creds?.sxbet),
    verifyPredictFun(creds?.predictfun),
    verifyCloudbet(creds?.cloudbet),
  ]);
}
