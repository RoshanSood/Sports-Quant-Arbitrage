// Kalshi live execution adapter (manual §12). Places real orders via the RSA-PSS signed
// V2 create-order endpoint (POST /portfolio/events/orders), using either per-request
// credentials (forwarded from the user's browser) or the server env. The V1 endpoint
// (/portfolio/orders) is deprecated (410 Gone) — V2 uses a single YES-side order book:
//   • buy YES → side "bid", price = our max YES price (dollars)
//   • buy NO  → side "ask" (selling YES ≡ buying NO), price = 1 − our max NO price
// time_in_force "immediate_or_cancel" crosses the spread now and cancels any unfilled
// remainder, so no naked resting order is ever left (no manual poll/cancel needed —
// Kalshi IOC is atomic, which is why this adapter has no confirmFill). Guarded upstream
// by the execution gate.

import crypto from "node:crypto";
import { isKalshiConfigured, kalshiGet, kalshiPost, type KalshiCreds } from "@/lib/kalshiAuth";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

type KalshiBalance = { balance?: number }; // cents
type KalshiV2OrderResp = {
  order_id?: string;
  client_order_id?: string;
  fill_count?: string; // fixed-point string, e.g. "10.00"
  remaining_count?: string;
  average_fill_price?: string; // YES price in dollars, present when fill_count > 0
  ts_ms?: number;
};

export class KalshiExecutionAdapter implements ExecutionAdapter {
  id = "kalshi";
  constructor(private creds?: KalshiCreds) {}

  supportsLive(): boolean {
    return isKalshiConfigured(this.creds);
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
    const ticker = req.nativeMarketId;
    const yesNo = (req.nativeSide ?? "").toLowerCase();
    if (!ticker || (yesNo !== "yes" && yesNo !== "no")) {
      return reject(req, "missing Kalshi native ticker/side — live order not wired for this leg");
    }

    // Everything is quoted from the YES side. Buying NO is a YES ask at (1 − no_price).
    const isYes = yesNo === "yes";
    const yesPriceDollars = (isYes ? req.limitPriceCents : 100 - req.limitPriceCents) / 100;
    if (yesPriceDollars <= 0 || yesPriceDollars >= 1) {
      return reject(req, `Kalshi price out of range (${yesPriceDollars})`);
    }

    const body = {
      ticker,
      client_order_id: crypto.randomUUID(),
      side: isYes ? "bid" : "ask",
      count: req.sizeContracts.toFixed(2), // fixed-point count, e.g. "10.00"
      price: yesPriceDollars.toFixed(4), // YES price in dollars
      time_in_force: "immediate_or_cancel", // cross now; cancel any unfilled remainder
      self_trade_prevention_type: "taker_at_cross",
    };

    try {
      const resp = await kalshiPost<KalshiV2OrderResp>("/portfolio/events/orders", body, this.creds);
      const orderId = resp.order_id ?? null;
      const filled = Math.round(Number(resp.fill_count) || 0);
      // average_fill_price is the YES fill price; convert back to the outcome's cost.
      const avgYes = Number(resp.average_fill_price);
      const avgPriceCents = Number.isFinite(avgYes) && avgYes > 0
        ? Math.round((isYes ? avgYes : 1 - avgYes) * 100)
        : req.limitPriceCents;
      const status = filled >= req.sizeContracts ? "filled" : filled > 0 ? "partial" : "unfilled";
      return { ok: filled > 0, orderId, filledContracts: filled, avgPriceCents, status, raw: resp };
    } catch (e) {
      return reject(req, String(e));
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
