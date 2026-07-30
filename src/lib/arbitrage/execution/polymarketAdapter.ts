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

function normalizeFunder(value?: string): string | undefined {
  return value?.trim().match(/^0x[a-fA-F0-9]{40}/)?.[0];
}

function configuredDepositWallet(): string | undefined {
  return normalizeFunder(process.env.POLYMARKET_DEPOSIT_WALLET);
}

async function buildClient(key: string, funderOverride?: string, sigTypeOverride?: number): Promise<ClobClient> {
  const wallet = new Wallet(key);
  const signer = clobSignerShim(wallet);
  const host = polymarketClobHost();
  const chainId = POLYGON_CHAIN_ID as Chain;
  const depositWallet = configuredDepositWallet();
  const uiFunder = normalizeFunder(funderOverride);
  const funder = uiFunder || depositWallet || normalizeFunder(process.env.POLYMARKET_FUNDER) || (await wallet.getAddress());
  const st = Number.isFinite(sigTypeOverride) ? signatureType(sigTypeOverride) : depositWallet && funder.toLowerCase() === depositWallet.toLowerCase() ? SignatureTypeV2.POLY_1271 : signatureType();
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
  error?: string;
  errorMsg?: string;
  orderID?: string;
  status?: string;
  takingAmount?: string; // shares received (BUY)
  makingAmount?: string; // USDC paid (BUY)
};

export type PolymarketFillQuote = {
  limitPriceCents: number;
  avgPriceCents: number;
  availableContracts: number;
  availableStakeUsd: number;
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

function floorTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * scale) / scale;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function polymarketFokBuyAmount(sizeContracts: number, limitPriceCents: number): number {
  return roundTo(sizeContracts * (limitPriceCents / 100), 2);
}

function filledContractsFrom(resp: PostOrderResponse, fallback: number): number {
  const shares = Number(resp.takingAmount);
  return Number.isFinite(shares) && shares > 0 ? shares : fallback;
}

function orderError(resp: PostOrderResponse): string {
  const message = resp.errorMsg || resp.error || "";
  if (/maker address not allowed|deposit wallet flow/i.test(message)) {
    return "Polymarket rejected direct EOA/MetaMask CLOB order placement; current API requires the deposit-wallet/POLY_1271 flow for this maker";
  }
  return message || `order not filled (${resp.status ?? "unknown"})`;
}

function readAskLevels(book: { asks?: Array<{ price?: string; size?: string }> }): Array<{ price: number; size: number }> {
  return (book.asks ?? [])
    .map((a) => ({ price: Number(a.price), size: Number(a.size) }))
    .filter((a) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.price > 0 && a.price < 1 && a.size > 0)
    .sort((a, b) => a.price - b.price);
}

export function polymarketFillQuoteFromAsks(
  asks: Array<{ price?: string; size?: string }>,
  maxPriceCents: number,
  targetContracts: number
): PolymarketFillQuote | null {
  const levels = readAskLevels({ asks }).filter((a) => a.price * 100 <= maxPriceCents + 1e-9);
  if (!levels.length) return null;
  let remaining = Math.max(0, targetContracts);
  let contracts = 0;
  let cost = 0;
  let worstPrice = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(level.size, remaining);
    contracts += take;
    cost += take * level.price;
    worstPrice = Math.max(worstPrice, level.price);
    remaining -= take;
  }
  if (contracts <= 0 || cost <= 0) return null;
  return {
    limitPriceCents: Math.ceil(worstPrice * 10_000) / 100,
    avgPriceCents: (cost / contracts) * 100,
    availableContracts: contracts,
    availableStakeUsd: cost,
  };
}

export async function quotePolymarketFokBuy(
  req: OrderRequest,
  creds?: PolymarketCreds,
  maxPriceCents: number = req.limitPriceCents
): Promise<PolymarketFillQuote | null> {
  const key = walletKey("polymarket", creds?.key);
  if (!key || !req.nativeSide) return null;
  const client = await buildClient(key, creds?.funder, creds?.sigType);
  const book = await client.getOrderBook(req.nativeSide);
  return polymarketFillQuoteFromAsks(book.asks, maxPriceCents, req.sizeContracts);
}

export class PolymarketExecutionAdapter implements ExecutionAdapter {
  id = "polymarket";
  constructor(private creds?: PolymarketCreds) {}

  private key(): string | undefined {
    return walletKey("polymarket", this.creds?.key);
  }

  private funder(): string | undefined {
    return this.creds?.funder;
  }

  private sigType(): number | undefined {
    return this.creds?.sigType;
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
    try {
      const ba = await polymarketBalanceAllowance(key, this.funder(), this.sigType());
      if (Number.isFinite(ba.balance)) return ba.balance;
    } catch {
      // Fall back to a direct on-chain read for older EOA/proxy flows.
    }
    const owner = normalizeFunder(this.funder()) || configuredDepositWallet() || normalizeFunder(process.env.POLYMARKET_FUNDER) || eoa;
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
      const client = await buildClient(key, this.funder(), this.sigType());
      const amount = polymarketFokBuyAmount(req.sizeContracts, req.limitPriceCents);
      if (amount <= 0) return reject(req, "Polymarket order cost rounds below $0.01");
      // createMarketOrder keeps FOK buy maker amounts at cent precision and derives
      // the CLOB token amount at Polymarket's required precision.
      const signed = await client.createMarketOrder({ tokenID, amount, price, side: Side.BUY, orderType: OrderType.FOK });
      const resp = (await client.postOrder(signed, OrderType.FOK)) as PostOrderResponse;

      const ok = resp.success === true && Boolean(resp.orderID);
      // FOK is all-or-nothing: success ⇒ fully filled, else nothing filled.
      const filled = ok ? filledContractsFrom(resp, req.sizeContracts) : 0;
      return {
        ok,
        orderId: resp.orderID ?? null,
        filledContracts: filled,
        avgPriceCents: avgCentsFrom(resp, req.limitPriceCents),
        status: ok ? "filled" : "unfilled",
        error: ok ? undefined : orderError(resp),
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
