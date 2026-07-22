// predict.fun live order adapter. Balance verification authenticates the Predict Account
// and reads the SDK's protocol USDT balance; order signing uses the official SDK's
// BNB-native CLOB flow.
// Signs a marketable LIMIT BUY with the OFFICIAL @predictdotfun/sdk (ethers v6) and posts it to
// POST /v1/orders with the x-api-key. The leg's nativeMarketId is the predict.fun market
// id and nativeSide is the outcome's on-chain token id. Credentials come from env
// (PREDICTFUN_API_KEY + PREDICTFUN_WALLET_KEY); the wallet key never leaves the process.
//
// NOTE: UNVALIDATED — like the other on-chain venues, the exact create-order response
// envelope + order semantics must be confirmed with a $1 live trade. The signing flow is
// the SDK's documented path. Before trading, run the SDK's setApprovals() once (ERC-1155
// CTF + ERC-20 USDT to the exchanges) — the wallet also needs a little BNB for that gas.

import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import { JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import { BNB_USDT_DECIMALS, bnbRpcUrl } from "./chains";
import type { PredictFunCreds } from "./onchainCreds";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

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

      // Marketable LIMIT BUY at our max price.
      const amounts = builder.getLimitOrderAmounts({
        side: Side.BUY,
        pricePerShareWei: parseUnits((req.limitPriceCents / 100).toFixed(6), 18),
        quantityWei: parseUnits(String(req.sizeContracts), 18),
      });
      const order = builder.buildOrder("LIMIT", {
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
            strategy: "LIMIT",
            isFillOrKill: true,
          },
        }),
      });
      const text = await res.text();
      let body: { success?: boolean; data?: { orderId?: string; filledSize?: string; status?: string }; message?: string } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        // non-JSON
      }
      if (!res.ok || body.success === false) return reject(req, body.message || `order rejected (HTTP ${res.status})`);

      // Response envelope unvalidated — treat an accepted order as filled unless it
      // reports a smaller size; reconciliation/naked detection covers the rest.
      const filled = Number(body.data?.filledSize);
      const filledContracts = Number.isFinite(filled) && filled > 0 ? filled : req.sizeContracts;
      return {
        ok: true,
        orderId: body.data?.orderId ?? hash,
        filledContracts,
        avgPriceCents: req.limitPriceCents,
        status: filledContracts >= req.sizeContracts ? "filled" : "partial",
        raw: body,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
