// predict.fun live order adapter. Balance verification authenticates the Predict Account
// and reads the SDK's protocol USDT balance; order signing uses the official SDK's
// BNB-native CLOB flow.
// Signs a MARKET BUY with the OFFICIAL @predictdotfun/sdk (ethers v6) and posts it to
// POST /v1/orders with the x-api-key. The leg's nativeMarketId is the predict.fun market
// id and nativeSide is the outcome's on-chain token id. Credentials come from env
// (PREDICTFUN_API_KEY + PREDICTFUN_WALLET_KEY); the wallet key never leaves the process.
//
// NOTE: UNVALIDATED — like the other on-chain venues, the exact create-order response
// envelope + order semantics must be confirmed with a $1 live trade. The signing flow is
// the SDK's documented path. Before trading, run the SDK's setApprovals() once (ERC-1155
// CTF + ERC-20 USDT to the exchanges) — the wallet also needs a little BNB for that gas.

import { ChainId, OrderBuilder, Side, type Book } from "@predictdotfun/sdk";
import { JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import { BNB_USDT_DECIMALS, bnbRpcUrl } from "./chains";
import type { PredictFunCreds } from "./onchainCreds";
import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

const API = "https://api.predict.fun";

// Creds come from the browser (per-request) or server env. The wallet key is used only
// to sign, never persisted/logged.
export function pfApiKey(c?: PredictFunCreds): string | undefined {
  return c?.apiKey?.trim() || process.env.PREDICTFUN_API_KEY?.trim() || undefined;
}
export function pfWalletKey(c?: PredictFunCreds): string | undefined {
  return c?.walletKey?.trim() || process.env.PREDICTFUN_WALLET_KEY?.trim() || undefined;
}
// The ZeroDev smart account (deposit address) that actually holds the USDT + trades.
// Falls back to the signer's own address when not provided.
export function pfAccount(c?: PredictFunCreds): string | undefined {
  return c?.account?.trim() || process.env.PREDICTFUN_ACCOUNT?.trim() || undefined;
}

type PfMarketFlags = { feeRateBps: number; isNegRisk: boolean; isYieldBearing: boolean };
type JsonRecord = Record<string, unknown>;
type PfBook = Omit<Book, "marketId"> & { marketId?: number };
type PfOrderData = {
  id?: string | number;
  orderId?: string | number;
  orderHash?: string;
  hash?: string;
  amount?: string | number;
  amountFilled?: string | number;
  filledAmount?: string | number;
  filledSize?: string | number;
  filled?: string | number;
  fillSize?: string | number;
  matchedSize?: string | number;
  status?: string;
  marketId?: string | number;
  order?: {
    hash?: string;
    tokenId?: string;
  };
};
type PfOrderResponse = {
  success?: boolean;
  data?: PfOrderData;
  message?: string;
};

async function marketFlags(marketId: string, apiKey: string): Promise<PfMarketFlags> {
  try {
    const r = await fetch(`${API}/v1/markets/${marketId}`, { headers: { "x-api-key": apiKey, Accept: "application/json" }, cache: "no-store" });
    const m = (await r.json())?.data ?? {};
    return {
      feeRateBps: typeof m.feeRateBps === "number" ? m.feeRateBps : 200,
      isNegRisk: Boolean(m.isNegRisk),
      isYieldBearing: m.isYieldBearing !== false, // observed default true
    };
  } catch {
    return { feeRateBps: 200, isNegRisk: false, isYieldBearing: true };
  }
}

function normalizeBook(marketId: string, body: unknown): PfBook | null {
  const data = asRecord(asRecord(body)?.data) ?? asRecord(body);
  const asks = data?.asks;
  const bids = data?.bids;
  if (!Array.isArray(asks) || !Array.isArray(bids)) return null;

  const toLevels = (levels: unknown[]) =>
    levels.flatMap((level) => {
      if (!Array.isArray(level) || level.length < 2) return [];
      const price = Number(level[0]);
      const qty = Number(level[1]);
      return Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0 ? ([[price, qty]] as [number, number][]) : [];
    });

  return {
    marketId: Number(marketId),
    updateTimestampMs: Number(data?.updateTimestampMs ?? Date.now()),
    asks: toLevels(asks).sort((a, b) => a[0] - b[0]),
    bids: toLevels(bids).sort((a, b) => b[0] - a[0]),
  };
}

async function orderbook(marketId: string, apiKey: string): Promise<PfBook> {
  const body = await fetchJson(`${API}/v1/markets/${marketId}/orderbook`, { headers: { "x-api-key": apiKey, Accept: "application/json" } });
  const book = normalizeBook(marketId, body);
  if (!book || book.asks.length === 0) throw new Error("predict.fun orderbook has no ask liquidity");
  return book;
}

function asRecord(v: unknown): JsonRecord | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;
}

function pickString(body: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let cur: unknown = body;
    for (const key of path) cur = asRecord(cur)?.[key];
    if (typeof cur === "string" && cur.trim()) return cur.trim();
  }
  return null;
}

function pickNumber(body: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    let cur: unknown = body;
    for (const key of path) cur = asRecord(cur)?.[key];
    const n = parseAmount(cur);
    if (n != null) return n;
  }
  return null;
}

function parseAmount(v: unknown): number | null {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  // predict.fun API examples show decimal strings, but signed-order/on-chain-shaped
  // payloads may surface 18-decimal wei amounts. Normalize both into share units.
  return Math.abs(n) > 1_000_000_000_000 ? n / 1e18 : n;
}

function findBalanceLike(body: unknown): number | null {
  const seen = new Set<unknown>();
  function walk(v: unknown, key = ""): number | null {
    if (v == null || seen.has(v)) return null;
    if (typeof v === "object") seen.add(v);
    const k = key.toLowerCase();
    const looksLikeBalance = k.includes("balance") || k.includes("buyingpower") || k.includes("buying_power") || k.includes("available");
    if ((typeof v === "number" || typeof v === "string") && looksLikeBalance) {
      const n = Number(v);
      if (Number.isFinite(n)) return n > 1_000_000 ? n / 1e18 : n;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = walk(item, key);
        if (found != null) return found;
      }
    } else {
      const rec = asRecord(v);
      if (rec) {
        for (const [childKey, childValue] of Object.entries(rec)) {
          const found = walk(childValue, childKey);
          if (found != null) return found;
        }
      }
    }
    return null;
  }
  return walk(body);
}

export function parsePredictFunFilledContracts(body: unknown, requestedSize: number): { filled: number; status: OrderResult["status"] } {
  const data = asRecord(body)?.data ?? body;
  const filled =
    pickNumber(data, [
      ["amountFilled"],
      ["filledAmount"],
      ["filledSize"],
      ["filled"],
      ["fillSize"],
      ["matchedSize"],
    ]) ?? 0;
  if (filled > 0) {
    return { filled, status: filled >= requestedSize ? "filled" : "partial" };
  }

  const status = String(asRecord(data)?.status ?? "").toLowerCase();
  if (["filled", "executed", "matched", "complete", "completed"].includes(status)) {
    return { filled: requestedSize, status: "filled" };
  }
  if (["partial", "partially_filled", "partially-filled"].includes(status)) {
    return { filled: 0, status: "partial" };
  }
  return { filled: 0, status: "unfilled" };
}

function orderData(body: unknown): PfOrderData | null {
  const data = asRecord(body)?.data ?? body;
  return asRecord(data) as PfOrderData | null;
}

function orderIdOf(data: PfOrderData | null): string | null {
  if (!data) return null;
  const v = data.orderId ?? data.id ?? data.orderHash ?? data.hash ?? data.order?.hash;
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}

function orderMatches(data: PfOrderData, orderIdOrHash: string): boolean {
  return [data.id, data.orderId, data.orderHash, data.hash, data.order?.hash].some((v) => v != null && String(v) === orderIdOrHash);
}

function listData(body: unknown): PfOrderData[] {
  const data = asRecord(body)?.data;
  return Array.isArray(data) ? data.filter((v): v is PfOrderData => Boolean(asRecord(v))) : [];
}

function positionAmountForOutcome(body: unknown, marketId: string, tokenId: string): number | null {
  for (const item of listData(body)) {
    const rec = asRecord(item);
    const market = asRecord(rec?.market);
    const outcome = asRecord(rec?.outcome);
    const marketMatch = String(market?.id ?? rec?.marketId ?? "") === marketId;
    const tokenMatch = String(outcome?.onChainId ?? outcome?.tokenId ?? "") === tokenId;
    if (marketMatch && tokenMatch) return parseAmount(rec?.amount) ?? 0;
  }
  return null;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const r = await fetch(url, { ...init, cache: "no-store" });
  const text = await r.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!r.ok) throw new Error(pickString(body, [["message"], ["error"]]) ?? `HTTP ${r.status}`);
  return body;
}

async function pfJwt(apiKey: string, walletKey: string, account?: string): Promise<string> {
  const signer = new Wallet(walletKey, new JsonRpcProvider(bnbRpcUrl()));
  const msgBody = await fetchJson(`${API}/v1/auth/message`, { headers: { "x-api-key": apiKey, Accept: "application/json" } });
  const message = pickString(msgBody, [["data", "message"], ["message"], ["data"]]);
  if (!message) throw new Error("auth message missing from predict.fun");

  const signature = account
    ? await (await OrderBuilder.make(ChainId.BnbMainnet, signer, { predictAccount: account })).signPredictAccountMessage(message)
    : await signer.signMessage(message);

  const attempts = account
    ? [
        { signer: account, signature, message },
        { signer: signer.address, account, signature, message },
      ]
    : [
        { signer: signer.address, signature, message },
      ];

  let lastError = "auth failed";
  for (const data of attempts) {
    try {
      const body = await fetchJson(`${API}/v1/auth`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      });
      const token = pickString(body, [["data", "token"], ["token"]]);
      if (token) return token;
      lastError = "auth response missing token";
    } catch (e) {
      lastError = String(e).slice(0, 120);
    }
  }
  throw new Error(lastError);
}

async function pfAccountApiBalance(c: PredictFunCreds): Promise<{ address: string | null; balance: number | null; message?: string }> {
  const apiKey = pfApiKey(c);
  const walletKey = pfWalletKey(c);
  if (!apiKey || !walletKey) return { address: null, balance: null };
  const account = pfAccount(c);
  const token = await pfJwt(apiKey, walletKey, account);
  const body = await fetchJson(`${API}/v1/account`, {
    headers: { "x-api-key": apiKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  return {
    address: pickString(body, [["data", "address"], ["address"]]),
    balance: findBalanceLike(body),
    message: "predict.fun account authenticated",
  };
}

export async function pfUsdtBalance(c: PredictFunCreds): Promise<number | null> {
  try {
    const apiBalance = await pfAccountApiBalance(c);
    if (apiBalance.balance != null) return apiBalance.balance;
  } catch {
    // Fall through to the SDK's on-protocol balance read.
  }
  try {
    const key = pfWalletKey(c);
    if (!key) return null;
    const signer = new Wallet(key, new JsonRpcProvider(bnbRpcUrl()));
    const account = pfAccount(c);
    const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer, account ? { predictAccount: account } : undefined);
    return Number(formatUnits(await builder.balanceOf(), BNB_USDT_DECIMALS));
  } catch {
    return null;
  }
}

export async function pfAccountAddress(c: PredictFunCreds): Promise<string | null> {
  try {
    return (await pfAccountApiBalance(c)).address;
  } catch {
    return null;
  }
}

// One-time on-chain approvals (ERC-1155 CTF + ERC-20 USDT to the exchanges) via the SDK's
// setApprovals(), which approves everything the protocol may need in a single call. The
// signer needs a little BNB for gas unless the ZeroDev smart account sponsors it. Returns
// a serializable summary (never the raw receipts).
export async function pfSetApprovals(c: PredictFunCreds): Promise<{ ok: boolean; txHashes: string[]; error?: string }> {
  const key = pfWalletKey(c);
  if (!key) return { ok: false, txHashes: [], error: "predict.fun wallet key not configured" };
  try {
    const signer = new Wallet(key, new JsonRpcProvider(bnbRpcUrl()));
    const account = pfAccount(c);
    const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer, account ? { predictAccount: account } : undefined);
    const result = await builder.setApprovals();
    const txHashes: string[] = [];
    for (const t of result.transactions ?? []) {
      const hash = (t as { receipt?: { hash?: string } })?.receipt?.hash;
      if (hash) txHashes.push(hash);
    }
    return { ok: Boolean(result.success), txHashes };
  } catch (e) {
    return { ok: false, txHashes: [], error: String(e).slice(0, 200) };
  }
}

export class PredictFunExecutionAdapter implements ExecutionAdapter {
  id = "predictfun";
  constructor(private creds?: PredictFunCreds) {}

  supportsLive(): boolean {
    return Boolean(pfApiKey(this.creds) && pfWalletKey(this.creds));
  }

  async getBalanceUsd(): Promise<number | null> {
    const key = pfWalletKey(this.creds);
    if (!key) return null;
    try {
      // Prefer the ZeroDev smart account (where the USDT lives); fall back to the signer.
      return await pfUsdtBalance(this.creds ?? {});
    } catch {
      return null;
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const apiKey = pfApiKey(this.creds);
    const walletKey = pfWalletKey(this.creds);
    if (!apiKey || !walletKey) return reject(req, "predict.fun API key / wallet key not configured");

    const marketId = req.nativeMarketId;
    const tokenId = req.nativeSide; // outcome on-chain token id
    if (!marketId || !tokenId) return reject(req, "missing predict.fun market/token id — live order not wired for this leg");
    if (req.sizeContracts < 2) return reject(req, "predict.fun minimum order is 2 shares");

    try {
      const flags = await marketFlags(marketId, apiKey);
      const signer = new Wallet(walletKey, new JsonRpcProvider(bnbRpcUrl()));
      const account = pfAccount(this.creds);
      // Pass the smart account as the order maker when trading a ZeroDev/proxy account.
      const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer, account ? { predictAccount: account } : undefined);

      const book = await orderbook(marketId, apiKey);
      const amounts = builder.getMarketOrderAmounts(
        {
          side: Side.BUY,
          quantityWei: parseUnits(String(req.sizeContracts), 18),
        },
        book
      );
      const lastPriceCents = Number(formatUnits(amounts.lastPrice, 18)) * 100;
      if (!Number.isFinite(lastPriceCents) || lastPriceCents > req.limitPriceCents) {
        return reject(req, `predict.fun ask moved above limit (${lastPriceCents.toFixed(2)}c > ${req.limitPriceCents.toFixed(2)}c)`);
      }
      const order = builder.buildOrder("MARKET", {
        side: Side.BUY,
        tokenId,
        makerAmount: amounts.makerAmount,
        takerAmount: amounts.takerAmount,
        feeRateBps: BigInt(flags.feeRateBps),
      });
      const typed = builder.buildTypedData(order, { isNegRisk: flags.isNegRisk, isYieldBearing: flags.isYieldBearing });
      const signed = await builder.signTypedDataOrder(typed);
      const hash = builder.buildTypedDataHash(typed);
      const token = await pfJwt(apiKey, walletKey, account);

      const res = await fetch(`${API}/v1/orders`, {
        method: "POST",
        headers: { "x-api-key": apiKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          data: {
            order: { ...signed, hash },
            pricePerShare: amounts.pricePerShare.toString(),
            strategy: "MARKET",
            isFillOrKill: true,
            slippageBps: Number(amounts.slippageBps),
          },
        }),
      });
      const text = await res.text();
      let body: PfOrderResponse = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        // non-JSON
      }
      if (!res.ok || body.success === false) return reject(req, body.message || `order rejected (HTTP ${res.status})`);

      // Create-order usually acks with ids only. In live trading these accepted orders
      // have been filling shortly after submit, so default to the requested size and let
      // reconciliation correct it if the order query reports a smaller/failed fill.
      const parsed = parsePredictFunFilledContracts(body, req.sizeContracts);
      const filledContracts = parsed.filled > 0 ? parsed.filled : req.sizeContracts;
      const status = parsed.filled > 0 ? parsed.status : "filled";
      const data = orderData(body);
      return {
        ok: true,
        orderId: orderIdOf(data) ?? hash,
        filledContracts,
        avgPriceCents: Number(formatUnits(amounts.pricePerShare, 18)) * 100 || req.limitPriceCents,
        status,
        raw: body,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }

  async confirmFill(orderId: string, req: OrderRequest): Promise<FillConfirmation> {
    const apiKey = pfApiKey(this.creds);
    const walletKey = pfWalletKey(this.creds);
    if (!apiKey || !walletKey) return { status: "unknown" };

    const token = await pfJwt(apiKey, walletKey, pfAccount(this.creds));
    const headers = { "x-api-key": apiKey, Authorization: `Bearer ${token}`, Accept: "application/json" };

    const direct = await fetchJson(`${API}/v1/orders/${encodeURIComponent(orderId)}`, { headers }).catch(() => null);
    let data = orderData(direct);

    if (!data || !orderMatches(data, orderId)) {
      const qs = new URLSearchParams({ first: "50" });
      const orders = await fetchJson(`${API}/v1/orders?${qs.toString()}`, { headers }).catch(() => null);
      data = listData(orders).find((o) => orderMatches(o, orderId)) ?? data;
    }

    if (data) {
      const parsed = parsePredictFunFilledContracts({ data }, req.sizeContracts);
      if (parsed.filled > 0) return { status: "settled", filledContracts: parsed.filled };
      const status = String(data.status ?? "").toUpperCase();
      if (["OPEN", "PENDING", "PARTIAL", "PARTIALLY_FILLED"].includes(status)) return { status: "pending", filledContracts: 0 };
      if (["CANCELED", "CANCELLED", "EXPIRED", "FAILED", "REJECTED"].includes(status)) return { status: "failed", filledContracts: 0 };
      if (["FILLED", "EXECUTED", "MATCHED", "COMPLETE", "COMPLETED"].includes(status)) {
        return { status: "settled", filledContracts: req.sizeContracts };
      }
    }

    if (req.nativeMarketId && req.nativeSide) {
      const qs = new URLSearchParams({ first: "50", marketId: req.nativeMarketId });
      const positions = await fetchJson(`${API}/v1/positions?${qs.toString()}`, { headers }).catch(() => null);
      const amount = positionAmountForOutcome(positions, req.nativeMarketId, req.nativeSide);
      if (amount != null && amount > 0) return { status: "settled", filledContracts: Math.min(amount, req.sizeContracts) };
    }

    // Accepted limit orders may rest before matching, so absence from the fill views is
    // pending rather than a hard settlement failure.
    return { status: "pending", filledContracts: 0 };
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
