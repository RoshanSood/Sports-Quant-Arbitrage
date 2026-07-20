// predict.fun live order adapter (BNB Chain, USDT). Signs a marketable LIMIT BUY with the
// OFFICIAL @predictdotfun/sdk (ethers v6 — matches our stack) and posts it to
// POST /v1/orders with the x-api-key. The leg's nativeMarketId is the predict.fun market
// id and nativeSide is the outcome's on-chain token id. Credentials come from env
// (PREDICTFUN_API_KEY + PREDICTFUN_WALLET_KEY); the wallet key never leaves the process.
//
// NOTE: UNVALIDATED — like the other on-chain venues, the exact create-order response
// envelope + order semantics must be confirmed with a $1 live trade. The signing flow is
// the SDK's documented path. Before trading, run the SDK's setApprovals() once (ERC-1155
// CTF + ERC-20 USDT to the exchanges) — the wallet also needs a little BNB for that gas.

import { AddressesByChainId, ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import { Contract, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import { BNB_CHAIN_ID, BNB_USDT_DECIMALS, ERC20_ABI, bnbRpcUrl } from "./chains";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

const API = "https://api.predict.fun";

export function pfApiKey(): string | undefined {
  return process.env.PREDICTFUN_API_KEY?.trim() || undefined;
}
export function pfWalletKey(): string | undefined {
  return process.env.PREDICTFUN_WALLET_KEY?.trim() || undefined;
}

type PfMarketFlags = { feeRateBps: number; isNegRisk: boolean; isYieldBearing: boolean };

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

// USDT balance on BNB for an address (18 decimals).
export async function pfUsdtBalance(address: string): Promise<number | null> {
  try {
    const usdt = AddressesByChainId[BNB_CHAIN_ID].USDT;
    const c = new Contract(usdt, ERC20_ABI, new JsonRpcProvider(bnbRpcUrl()));
    const raw = (await c.balanceOf(address)) as bigint;
    return Number(formatUnits(raw, BNB_USDT_DECIMALS));
  } catch {
    return null;
  }
}

export class PredictFunExecutionAdapter implements ExecutionAdapter {
  id = "predictfun";

  supportsLive(): boolean {
    return Boolean(pfApiKey() && pfWalletKey());
  }

  async getBalanceUsd(): Promise<number | null> {
    const key = pfWalletKey();
    if (!key) return null;
    try {
      return await pfUsdtBalance(new Wallet(key).address);
    } catch {
      return null;
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const apiKey = pfApiKey();
    const walletKey = pfWalletKey();
    if (!apiKey || !walletKey) return reject(req, "predict.fun API key / wallet key not configured");

    const marketId = req.nativeMarketId;
    const tokenId = req.nativeSide; // outcome on-chain token id
    if (!marketId || !tokenId) return reject(req, "missing predict.fun market/token id — live order not wired for this leg");
    if (req.sizeContracts < 2) return reject(req, "predict.fun minimum order is 2 shares");

    try {
      const flags = await marketFlags(marketId, apiKey);
      const signer = new Wallet(walletKey, new JsonRpcProvider(bnbRpcUrl()));
      const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer);

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

      const res = await fetch(`${API}/v1/orders`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ data: { order: { ...signed, hash }, strategy: "LIMIT" } }),
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
