// Polymarket CLOB live order adapter (manual §12, §14). Signs and posts orders with
// the OFFICIAL @polymarket/clob-client. Each arb leg is a marketable **FOK** limit BUY
// at our max price: it either fills entirely and immediately at ≤ our price, or is
// killed — so we never leave a resting (naked) order, matching the arb "both legs or
// nothing" requirement. The wallet key is read server-side only and never leaves the
// process. A venue is live-capable once its wallet key is present; whether a live order
// actually fires is decided by the execution gate (agent Live toggle + kill switch +
// UI stake cap + admin auth) — validate with a $1 trade before raising the cap.

import {
  AssetType,
  ClobClient,
  type ApiKeyCreds,
  Chain,
  OrderType,
  Side,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";
// NOTE: international self-custody Polymarket adapter — currently UNUSED (the registry
// routes "polymarket" to the regulated Polymarket US adapter). Kept for recoverability.
import { POLYGON_CHAIN_ID, polymarketClobHost, polygonUsdcAddress } from "./chains";
import type { PolymarketCreds } from "./onchainCreds";
import { deriveEoa, providerFor, usdcBalance } from "./wallet";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";
import { clobSignerShim, walletKey } from "./wallet";

// Which signature scheme the funded wallet uses. Default EOA (direct wallet). Users
// whose USDC lives in a Polymarket proxy/safe pass funder + sigType (UI or env).
export const POLYMARKET_DEPOSIT_WALLET_SIG_TYPE = 3;

function signatureType(sig?: number): SignatureTypeV2 {
  const v = sig ?? Number(process.env.POLYMARKET_SIG_TYPE);
  if (v === POLYMARKET_DEPOSIT_WALLET_SIG_TYPE) return SignatureTypeV2.POLY_1271;
  if (v === 1) return SignatureTypeV2.POLY_PROXY;
  if (v === 2) return SignatureTypeV2.POLY_GNOSIS_SAFE;
  return SignatureTypeV2.EOA;
}

// Cache authenticated (L2) clients per wallet key — deriving API creds signs + hits the
// network, so we do it once per key (UI-entered or env). Keyed by the raw key string.
const clientCache = new Map<string, ClobClient>();

async function buildClient(key: string, funderOverride?: string, sigType?: number): Promise<ClobClient> {
  const wallet = new Wallet(key);
  const signer = clobSignerShim(wallet);
  const host = polymarketClobHost();
  const chainId = POLYGON_CHAIN_ID as Chain;
  const st = signatureType(sigType);
  const funder = funderOverride?.trim() || process.env.POLYMARKET_FUNDER?.trim() || (await wallet.getAddress());
  const cacheKey = `${key}:${funder.toLowerCase()}:${st}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  // L1: sign to create-or-derive the L2 API credentials, then build the L2 client.
  const l1 = new ClobClient({ host, chain: chainId, signer, signatureType: st, funderAddress: funder });
  const creds: ApiKeyCreds = await l1.createOrDeriveApiKey();
  const client = new ClobClient({ host, chain: chainId, signer, creds, signatureType: st, funderAddress: funder });

  clientCache.set(cacheKey, client);
  return client;
}

export type PolymarketBalanceAllowance = { balance: number; allowance: number };

function parseCollateralAmount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "bigint") return Number(value) / 1_000_000;
  if (typeof value !== "string") return NaN;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return NaN;
  return Number.isInteger(n) && Math.abs(n) >= 1_000_000 ? n / 1_000_000 : n;
}

function maxCollateralAmount(value: unknown): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const amounts = Object.values(value)
      .map(parseCollateralAmount)
      .filter(Number.isFinite);
    return amounts.length ? Math.max(...amounts) : NaN;
  }
  return parseCollateralAmount(value);
}

export async function polymarketBalanceAllowance(
  key: string,
  funderOverride?: string,
  sigType?: number
): Promise<PolymarketBalanceAllowance> {
  const client = await buildClient(key, funderOverride, sigType);
  const r = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const raw = r as unknown as { balance?: unknown; allowance?: unknown; allowances?: unknown };
  return {
    balance: parseCollateralAmount(raw.balance),
    allowance: maxCollateralAmount(raw.allowance ?? raw.allowances),
  };
}

export async function updatePolymarketBalanceAllowance(key: string, funderOverride?: string, sigType?: number): Promise<void> {
  const client = await buildClient(key, funderOverride, sigType);
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
}

type PostOrderResponse = {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  status?: string;
  takingAmount?: string; // shares received (BUY)
  makingAmount?: string; // USDC paid (BUY)
};

// avg fill price in cents from the response amounts (USDC paid / shares received),
// falling back to our limit when the amounts are absent.
function avgCentsFrom(resp: PostOrderResponse, limitCents: number): number {
  const paid = Number(resp.makingAmount);
  const shares = Number(resp.takingAmount);
  if (Number.isFinite(paid) && Number.isFinite(shares) && shares > 0) {
    return Math.round((paid / shares) * 100);
  }
  return limitCents;
}

export class PolymarketExecutionAdapter implements ExecutionAdapter {
  id = "polymarket";
  constructor(private creds?: PolymarketCreds) {}

  private key(): string | undefined {
    return walletKey("polymarket", this.creds?.key);
  }

  supportsLive(): boolean {
    // Live-capable once a wallet key is present (entered in the UI or env). The gate
    // (agent live toggle + kill switch + stake cap + admin auth) decides if it fires.
    return Boolean(this.key());
  }

  async getBalanceUsd(): Promise<number | null> {
    const key = this.key();
    if (!key) return null;
    const eoa = deriveEoa("polymarket", this.creds?.key);
    if (!eoa) return null;
    const owner = this.creds?.funder?.trim() || process.env.POLYMARKET_FUNDER?.trim() || eoa;
    try {
      return await usdcBalance(providerFor("polymarket"), polygonUsdcAddress(), owner);
    } catch {
      return null;
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const key = this.key();
    if (!key) return reject(req, "Polymarket wallet key not configured");

    // For Polymarket we thread the ERC-1155 CLOB token id as the leg's nativeSide.
    const tokenID = req.nativeSide;
    if (!tokenID) return reject(req, "missing Polymarket token id — live order not wired for this leg");

    const price = req.limitPriceCents / 100; // probability price 0..1
    try {
      const client = await buildClient(key, this.creds?.funder, this.creds?.sigType);
      // createOrder auto-resolves tickSize + negRisk for the token and rounds price.
      const signed = await client.createOrder({ tokenID, price, size: req.sizeContracts, side: Side.BUY });
      const resp = (await client.postOrder(signed, OrderType.FOK)) as PostOrderResponse;

      const ok = resp.success === true && Boolean(resp.orderID);
      // FOK is all-or-nothing: success ⇒ fully filled, else nothing filled.
      const filled = ok ? req.sizeContracts : 0;
      return {
        ok,
        orderId: resp.orderID ?? null,
        filledContracts: filled,
        avgPriceCents: avgCentsFrom(resp, req.limitPriceCents),
        status: ok ? "filled" : "unfilled",
        error: ok ? undefined : resp.errorMsg || `order not filled (${resp.status ?? "unknown"})`,
        raw: resp,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
