// Polymarket CLOB live order adapter (manual §12, §14). Signs and posts orders with
// the OFFICIAL @polymarket/clob-client. Each arb leg is a marketable **FOK** limit BUY
// at our max price: it either fills entirely and immediately at ≤ our price, or is
// killed — so we never leave a resting (naked) order, matching the arb "both legs or
// nothing" requirement. The wallet key is read server-side only and never leaves the
// process. A venue is live-capable once its wallet key is present; whether a live order
// actually fires is decided by the execution gate (agent Live toggle +
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
import axios from "axios";
import { Agent as HttpsAgent } from "node:https";
// NOTE: international self-custody Polymarket adapter — currently UNUSED (the registry
// routes "polymarket" to the regulated Polymarket US adapter). Kept for recoverability.
import { POLYGON_CHAIN_ID, polymarketClobHost, polygonUsdcAddress } from "./chains";
import type { PolymarketCreds } from "./onchainCreds";
import { deriveEoa, providerFor, usdcBalance } from "./wallet";
import type { ExecutableOrderQuote, ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";
import { clobSignerShim, walletKey } from "./wallet";
import { polymarketV3BuyAmounts } from "./polymarketAmounts";

export { polymarketV3BuyAmounts, type PolymarketV3BuyAmounts } from "./polymarketAmounts";

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
const clientVersionCache = new WeakMap<ClobClient, Promise<number>>();
const polymarketHttpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 16, maxFreeSockets: 8 });
// The SDK uses the shared axios module without exposing an agent option. Install one
// persistent TLS pool once so book/auth/order calls reuse sockets instead of handshaking on
// the latency-critical FOK request.
axios.defaults.httpsAgent = polymarketHttpsAgent;

function clientVersion(client: ClobClient): Promise<number> {
  const cached = clientVersionCache.get(client);
  if (cached) return cached;
  const pending = client.getVersion().catch((error) => {
    clientVersionCache.delete(client);
    throw error;
  });
  clientVersionCache.set(client, pending);
  return pending;
}

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


// avg fill price in cents from the response amounts (USDC paid / shares received),
// falling back to our limit when the amounts are absent. Kept at sub-cent precision
// (a fill at 79.8c must report 79.8, not round to 80) so the portfolio shows what was
// actually paid — the FOK crosses the ask ladder and often fills a few tenths above the
// detected top-of-book.
export function avgCentsFrom(resp: PostOrderResponse, limitCents: number): number {
  const paid = Number(resp.makingAmount);
  const shares = Number(resp.takingAmount);
  if (Number.isFinite(paid) && Number.isFinite(shares) && shares > 0) {
    return roundTo((paid / shares) * 100, 2);
  }
  return limitCents;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export async function warmPolymarketExecutionPath(creds?: PolymarketCreds): Promise<boolean> {
  const key = walletKey("polymarket", creds?.key);
  if (!key) return false;
  const client = await buildClient(key, creds?.funder, creds?.sigType);
  await Promise.all([clientVersion(client), client.getOk()]);
  return true;
}

// A live-book quote for how much a marketable FOK BUY can ACTUALLY fill at/below our price.
// Sizing the order to this (instead of the arb-detected size) is what lets the FOK fill
// rather than get killed for asking more than the book holds.
export type PolymarketFillQuote = {
  limitPriceCents: number; // worst ask we'd cross (send the FOK at >= this so it fills)
  avgPriceCents: number; // volume-weighted fill price
  availableContracts: number; // contracts fillable at <= maxPriceCents
  availableStakeUsd: number;
  levels: Array<{ priceCents: number; contracts: number }>;
};

function readAskLevels(asks?: Array<{ price?: string; size?: string }>): Array<{ price: number; size: number }> {
  return (asks ?? [])
    .map((a) => ({ price: Number(a.price), size: Number(a.size) }))
    .filter((a) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.price > 0 && a.price < 1 && a.size > 0)
    .sort((a, b) => a.price - b.price);
}

// Walk the ask ladder up to maxPriceCents, accumulating fillable contracts (capped at
// targetContracts). Returns null when nothing is offered at or under our price.
export function polymarketFillQuoteFromAsks(
  asks: Array<{ price?: string; size?: string }> | undefined,
  maxPriceCents: number,
  targetContracts: number
): PolymarketFillQuote | null {
  const levels = readAskLevels(asks).filter((a) => a.price * 100 <= maxPriceCents + 1e-9);
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
    levels: levels.map((level) => ({ priceCents: level.price * 100, contracts: level.size })),
  };
}

// Read the live CLOB ask book for this token and quote how much a FOK BUY can fill at or
// below maxPriceCents. Used to right-size the order pre-send so it fills instead of killing.
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

// Ground-truth fill decision from a FOK postOrder response. A real fill reports the actual
// shares received in `takingAmount`; absent/zero shares (or an explicit unmatched status)
// means the order was killed — report ZERO fill, never the requested size. This is the fix
// for phantom "filled" logs where the CLOB echoed an order hash but nothing matched.
export function polymarketFillFromResponse(
  resp: PostOrderResponse,
  requestedContracts: number
): { ok: boolean; filledContracts: number; status: "pending" | "filled" | "partial" | "unfilled" } {
  const venueStatus = typeof resp.status === "string" ? resp.status : "";
  if (venueStatus.toLowerCase() === "delayed" && !resp.error && !resp.errorMsg) {
    return { ok: true, filledContracts: 0, status: "pending" };
  }
  const shares = Number(resp.takingAmount);
  const explicitlyUnmatched = /unmatch|cancel|kill|not.?filled|reject/i.test(venueStatus);
  const filled = Number.isFinite(shares) && shares > 0 && !explicitlyUnmatched ? shares : 0;
  const ok = filled > 0 && !resp.error && !resp.errorMsg;
  return { ok, filledContracts: filled, status: ok ? (filled >= requestedContracts ? "filled" : "partial") : "unfilled" };
}

function orderError(resp: PostOrderResponse): string {
  const message = resp.errorMsg || resp.error || "";
  if (/maker address not allowed|deposit wallet flow/i.test(message)) {
    return "Polymarket rejected direct EOA/MetaMask CLOB order placement; current API requires the deposit-wallet/POLY_1271 flow for this maker";
  }
  return message || `order not filled (${resp.status ?? "unknown"})`;
}

export class PolymarketExecutionAdapter implements ExecutionAdapter {
  id = "polymarket";
  private preparedOrders = new Map<string, Promise<{
    client: ClobClient;
    signed: Parameters<ClobClient["postOrder"]>[0];
    submittedContracts: number;
  }>>();
  constructor(private creds?: PolymarketCreds) {}

  private preparedKey(req: OrderRequest): string {
    return `${req.nativeSide ?? ""}:${req.sizeContracts.toFixed(8)}:${req.limitPriceCents.toFixed(4)}`;
  }

  private async buildPreparedOrder(req: OrderRequest): Promise<{
    client: ClobClient;
    signed: Parameters<ClobClient["postOrder"]>[0];
    submittedContracts: number;
  }> {
    const key = this.key();
    if (!key) throw new Error("Polymarket wallet key not configured");
    const tokenID = req.nativeSide;
    if (!tokenID) throw new Error("missing Polymarket token id");
    if (req.sizeContracts <= 0) throw new Error("Polymarket order size must be positive");
    const client = await buildClient(key, this.funder(), this.sigType());
    const version = await clientVersion(client);
    let submittedContracts = req.sizeContracts;
    const signed = version === 3
      ? (() => {
          const amounts = polymarketV3BuyAmounts(req.sizeContracts, req.limitPriceCents);
          if (!amounts) throw new Error("Polymarket order is too small for exchange-v3 amount precision");
          submittedContracts = amounts.submittedContracts;
          return client.createExchangeV3OrderFromAmounts({
            tokenID,
            makerAmount: amounts.makerAmount,
            takerAmount: amounts.takerAmount,
            side: Side.BUY,
          });
        })()
      : client.createOrder(
          { tokenID, price: req.limitPriceCents / 100, size: req.sizeContracts, side: Side.BUY },
          { version: version === 1 ? 1 : 2 }
        );
    return { client, signed: await signed, submittedContracts };
  }

  async prepareOrder(req: OrderRequest): Promise<{ ok: boolean; reason?: string }> {
    const cacheKey = this.preparedKey(req);
    if (!this.preparedOrders.has(cacheKey)) this.preparedOrders.set(cacheKey, this.buildPreparedOrder(req));
    try {
      await this.preparedOrders.get(cacheKey);
      return { ok: true };
    } catch (error) {
      this.preparedOrders.delete(cacheKey);
      return { ok: false, reason: String(error).slice(0, 200) };
    }
  }

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
    // (agent live toggle + stake cap + admin auth) decides if it fires.
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

  async quoteOrder(req: OrderRequest): Promise<ExecutableOrderQuote> {
    try {
      const quote = await quotePolymarketFokBuy(req, this.creds, req.limitPriceCents);
      if (!quote) {
        return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: "Polymarket has no ask depth at or below the limit" };
      }
      return {
        ok: quote.availableContracts + 1e-9 >= req.sizeContracts,
        priceCents: quote.limitPriceCents,
        averagePriceCents: quote.avgPriceCents,
        availableContracts: quote.availableContracts,
        levels: quote.levels,
        reason: quote.availableContracts + 1e-9 >= req.sizeContracts
          ? undefined
          : `Polymarket executable depth ${quote.availableContracts.toFixed(2)} < ${req.sizeContracts}`,
      };
    } catch (e) {
      return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: `Polymarket order book check failed: ${String(e).slice(0, 120)}` };
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const key = this.key();
    if (!key) return reject(req, "Polymarket wallet key not configured");

    // For Polymarket we thread the ERC-1155 CLOB token id as the leg's nativeSide.
    const tokenID = req.nativeSide;
    if (!tokenID) return reject(req, "missing Polymarket token id — live order not wired for this leg");

    try {
      const cacheKey = this.preparedKey(req);
      const pending = this.preparedOrders.get(cacheKey) ?? this.buildPreparedOrder(req);
      this.preparedOrders.delete(cacheKey); // a signed FOK payload is single-use
      const { client, signed, submittedContracts } = await pending;
      const resp = (await client.postOrder(signed, OrderType.FOK)) as PostOrderResponse;

      // Decide fill from ACTUAL shares received, not from success+orderID (see helper).
      const { ok, filledContracts, status } = polymarketFillFromResponse(resp, submittedContracts);
      return {
        ok,
        orderId: resp.orderID ?? null,
        filledContracts,
        avgPriceCents: avgCentsFrom(resp, req.limitPriceCents),
        status,
        error: ok ? undefined : orderError(resp),
        raw: resp,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }

  // Re-query the CLOB for a matched trade created by THIS order on the token, so the
  // settlement reconciler can confirm a real fill instead of trusting the placement ack.
  // Returns "settled" (with the on-chain share count) when a matching trade is found,
  // "pending" when none is found yet (could be indexing lag — reconcile keeps polling; a
  // false "failed" here would wrongly flag a genuine hedge as naked), "unknown" on error.
  async confirmFill(orderId: string, req: OrderRequest): Promise<FillConfirmation> {
    const key = this.key();
    const tokenID = req.nativeSide;
    if (!key || !tokenID || !orderId) return { status: "unknown" };
    try {
      const client = await buildClient(key, this.funder(), this.sigType());
      const trades = (await client.getTrades({ asset_id: tokenID })) as Array<{
        id?: string; taker_order_id?: string; size?: string; price?: string; status?: string; trader_side?: string;
      }>;
      const seen = new Set<string>();
      const ours = (trades ?? []).filter((t) => {
        if (t.taker_order_id !== orderId || (t.trader_side && t.trader_side !== "TAKER")) return false;
        const key = t.id ?? `${t.taker_order_id}:${t.size}:${t.price}:${t.status}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // MATCHED/MINED is already an executed trade for exposure purposes. Waiting only for
      // final chain confirmation would temporarily call a real fill "unfilled" and could
      // create the exact false state seen on the Cardinals order.
      const matched = ours.filter((t) => /match|mined|confirm/i.test(t.status ?? ""));
      const shares = Math.min(req.sizeContracts, matched.reduce((sum, t) => sum + (Number(t.size) || 0), 0));
      const notional = matched.reduce((sum, t) => sum + (Number(t.size) || 0) * (Number(t.price) || 0), 0);
      if (shares > 0) {
        const matchedShares = matched.reduce((sum, t) => sum + (Number(t.size) || 0), 0);
        const avgPriceCents = notional > 0 ? (notional / matchedShares) * 100 : undefined;
        return { status: "settled", filledContracts: shares, avgPriceCents };
      }
      if (ours.some((t) => /fail|cancel/i.test(t.status ?? ""))) {
        return { status: "failed", filledContracts: 0, error: "Polymarket settlement failed" };
      }
      return { status: "pending" };
    } catch {
      return { status: "unknown" };
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
