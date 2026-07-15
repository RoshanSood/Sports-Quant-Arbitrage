// Kalshi live execution adapter (manual §12). Places real orders via the RSA-PSS
// signed V2 order endpoint, using either per-request credentials (forwarded from
// the user's browser) or the server env. Every order is fill-or-kill.

import crypto from "node:crypto";
import { isKalshiConfigured, kalshiGet, kalshiPost, type KalshiCreds } from "@/lib/kalshiAuth";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

type KalshiBalance = { balance?: number }; // cents
type KalshiOrder = {
  order_id?: string;
  fill_count?: string | number;
  fill_count_fp?: string | number;
  average_fill_price?: string | number;
  average_fill_price_dollars?: string | number;
};
type KalshiOrderResp = { order?: KalshiOrder } & KalshiOrder;

export type KalshiFokOrderBody = {
  ticker: string;
  side: "bid" | "ask";
  count: string;
  price: string;
  client_order_id: string;
  time_in_force: "fill_or_kill";
  self_trade_prevention_type: "taker_at_cross";
  post_only: false;
  cancel_order_on_pause: true;
};

export function buildKalshiFokOrder(
  req: OrderRequest,
  clientOrderId: string = crypto.randomUUID()
): KalshiFokOrderBody | null {
  const ticker = req.nativeMarketId;
  const side = (req.nativeSide ?? "").toLowerCase();
  if (
    !ticker
    || (side !== "yes" && side !== "no")
    || !Number.isFinite(req.sizeContracts)
    || req.sizeContracts <= 0
    || !Number.isFinite(req.limitPriceCents)
    || req.limitPriceCents <= 0
    || req.limitPriceCents >= 100
  ) return null;

  // V2 quotes the YES book: buying NO is an ask at the complementary price.
  const yesPrice = side === "yes" ? req.limitPriceCents / 100 : 1 - req.limitPriceCents / 100;
  return {
    ticker,
    side: side === "yes" ? "bid" : "ask",
    count: req.sizeContracts.toFixed(2),
    price: yesPrice.toFixed(4),
    client_order_id: clientOrderId,
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
    post_only: false,
    cancel_order_on_pause: true,
  };
}

export class KalshiExecutionAdapter implements ExecutionAdapter {
  id = "kalshi";
  constructor(private creds?: KalshiCreds) {}

  supportsLive(): boolean {
    return isKalshiConfigured(this.creds);
  }

  supportsFillOrKill(): boolean {
    return true;
  }

  async getBalanceUsd(): Promise<number | null> {
    if (!this.supportsLive()) return null;
    try {
      const b = await kalshiGet<KalshiBalance>("/portfolio/balance", {}, this.creds);
      return typeof b.balance === "number" ? b.balance / 100 : null;
    } catch (e) {
      console.error("[exec/kalshi] balance failed:", e);
      return null;
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.supportsLive()) {
      return reject(req, "Kalshi credentials not configured");
    }
    const side = (req.nativeSide ?? "").toLowerCase();
    const body = buildKalshiFokOrder(req);
    if (!body) {
      return reject(req, "missing Kalshi native ticker/side — live order not wired for this leg");
    }
    const yesPrice = Number(body.price);

    try {
      const resp = await kalshiPost<KalshiOrderResp>("/portfolio/events/orders", body, this.creds);
      const order = resp.order ?? resp;
      const orderId = order.order_id ?? null;
      const filled = Number(order.fill_count_fp ?? order.fill_count ?? 0);
      const rawAverage = Number(order.average_fill_price_dollars ?? order.average_fill_price);
      const yesAverage = Number.isFinite(rawAverage) && rawAverage > 0
        ? rawAverage > 1 ? rawAverage / 100 : rawAverage
        : yesPrice;
      const averageCents = (side === "yes" ? yesAverage : 1 - yesAverage) * 100;
      const fullyFilled = filled >= req.sizeContracts;
      return {
        ok: fullyFilled,
        orderId,
        filledContracts: fullyFilled ? req.sizeContracts : 0,
        avgPriceCents: Number(averageCents.toFixed(4)),
        status: fullyFilled ? "filled" : "unfilled",
        error: fullyFilled ? undefined : "Fill-or-kill order was not fully filled",
        raw: resp,
      };
    } catch (e) {
      return reject(req, String(e));
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
