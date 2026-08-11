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
import type { ExecutableOrderQuote, ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

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

export function predictAmountToContracts(raw: unknown): number {
  if (typeof raw !== "string" && typeof raw !== "number") return 0;
  const text = String(raw).trim();
  if (!text) return 0;
  if (text.includes(".")) {
    const decimal = Number(text);
    return Number.isFinite(decimal) && decimal > 0 ? decimal : 0;
  }
  try {
    const integer = BigInt(text);
    return integer > BigInt("1000000000000") ? Number(formatUnits(integer, 18)) : Number(integer);
  } catch {
    return 0;
  }
}

type PfMarketFlags = { feeRateBps: number; isNegRisk: boolean; isYieldBearing: boolean };
type JsonRecord = Record<string, unknown>;
type PfBook = Omit<Book, "marketId"> & { marketId?: number };

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

export async function quotePredictFunOrder(req: OrderRequest, creds?: PredictFunCreds): Promise<ExecutableOrderQuote> {
  const apiKey = pfApiKey(creds);
  const marketId = req.nativeMarketId;
  if (!apiKey || !marketId || !req.nativeSide) {
    return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: "missing predict.fun credentials/market/token id" };
  }
  try {
    const book = await orderbook(marketId, apiKey);
    const levels = book.asks
      .map(([price, quantity]) => ({ priceCents: price * 100, contracts: quantity }))
      .filter((level) => level.priceCents > 0 && level.priceCents <= req.limitPriceCents + 1e-9 && level.contracts > 0)
      .sort((a, b) => a.priceCents - b.priceCents);
    let remaining = req.sizeContracts;
    let availableContracts = 0;
    let costCents = 0;
    let worstPriceCents = 0;
    for (const [price, quantity] of book.asks) {
      const priceCents = price * 100;
      if (priceCents > req.limitPriceCents + 1e-9) break;
      if (!(quantity > 0)) continue;
      const take = Math.min(remaining, quantity);
      availableContracts += take;
      costCents += take * priceCents;
      worstPriceCents = Math.max(worstPriceCents, priceCents);
      remaining -= take;
      if (remaining <= 0) break;
    }
    if (availableContracts <= 0) {
      return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: "predict.fun has no ask depth at or below the limit" };
    }
    return {
      ok: availableContracts + 1e-9 >= req.sizeContracts,
      priceCents: worstPriceCents,
      averagePriceCents: costCents / availableContracts,
      availableContracts,
      levels,
      reason: availableContracts + 1e-9 >= req.sizeContracts ? undefined : `predict.fun executable depth ${availableContracts.toFixed(2)} < ${req.sizeContracts}`,
    };
  } catch (e) {
    return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: `predict.fun order book check failed: ${String(e).slice(0, 120)}` };
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

  quoteOrder(req: OrderRequest): Promise<ExecutableOrderQuote> {
    return quotePredictFunOrder(req, this.creds);
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
      let body: { success?: boolean; data?: { code?: string; orderId?: string; orderHash?: string }; message?: string } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        // non-JSON
      }
      if (!res.ok || body.success === false) return reject(req, body.message || `order rejected (HTTP ${res.status})`);

      // Predict.fun returns an acknowledgement here, not proof of execution. Keep the
      // order pending until GET /v1/orders/{orderHash} reports an actual filled amount.
      const orderId = body.data?.orderId ?? null;
      const orderHash = body.data?.orderHash ?? hash;
      return {
        ok: true,
        orderId,
        confirmationId: orderHash,
        filledContracts: 0,
        avgPriceCents: Number(formatUnits(amounts.pricePerShare, 18)) * 100 || req.limitPriceCents,
        status: "pending",
        raw: body,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }

  async confirmFill(orderHash: string, req: OrderRequest): Promise<FillConfirmation> {
    const apiKey = pfApiKey(this.creds);
    const walletKey = pfWalletKey(this.creds);
    if (!apiKey || !walletKey || !orderHash) return { status: "unknown" };
    try {
      const token = await pfJwt(apiKey, walletKey, pfAccount(this.creds));
      const body = asRecord(await fetchJson(`${API}/v1/orders/${encodeURIComponent(orderHash)}`, {
        headers: { "x-api-key": apiKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
      }));
      const data = asRecord(body?.data) ?? body;
      const filledContracts = predictAmountToContracts(data?.amountFilled);
      const status = String(data?.status ?? "").toUpperCase();
      const terminalFailure = /CANCEL|EXPIRE|REJECT|FAIL|INVALID/.test(status);
      const terminalSuccess = /FILL|MATCH|EXECUT|COMPLETE|SETTLE|CLOSED/.test(status);
      if (filledContracts > 0 && (terminalSuccess || terminalFailure)) {
        return { status: "settled", filledContracts: Math.min(req.sizeContracts, filledContracts) };
      }
      if (terminalFailure) return { status: "failed", filledContracts: 0, error: `Predict.fun order ${status.toLowerCase()}` };
      return { status: "pending", filledContracts };
    } catch {
      return { status: "unknown" };
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
