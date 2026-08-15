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
import type { ExecutableOrderQuote, ExecutionAdapter, OrderRequest, OrderResult } from "./types";

type KalshiBalance = { balance?: number }; // cents
type KalshiV2OrderResp = {
  order_id?: string;
  client_order_id?: string;
  fill_count?: string; // fixed-point string, e.g. "10.00"
  remaining_count?: string;
  average_fill_price?: string; // YES price in dollars, present when fill_count > 0
  ts_ms?: number;
};

type KalshiOrderRecord = KalshiV2OrderResp & {
  ticker?: string;
  status?: string;
  fill_count_fp?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
};

type KalshiOrdersResponse = { orders?: KalshiOrderRecord[] };

type KalshiMarketSnapshot = {
  market?: {
    yes_bid?: number;
    yes_ask?: number;
    yes_bid_dollars?: string | number;
    yes_ask_dollars?: string | number;
    yes_bid_size_fp?: number | string;
    yes_ask_size_fp?: number | string;
    status?: string;
  };
};

function centsFromMaybeDollars(cents?: number, dollars?: string | number): number | null {
  const d = Number(dollars);
  if (Number.isFinite(d) && d > 0 && d < 1) return Math.round(d * 100);
  if (typeof cents === "number" && Number.isFinite(cents) && cents > 0 && cents < 100) return Math.round(cents);
  return null;
}

export async function quoteKalshiOrder(req: OrderRequest, creds?: KalshiCreds): Promise<ExecutableOrderQuote> {
  const ticker = req.nativeMarketId;
  const yesNo = (req.nativeSide ?? "").toLowerCase();
  if (!ticker || (yesNo !== "yes" && yesNo !== "no")) {
    return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: "missing Kalshi native ticker/side" };
  }

  try {
    const snapshot = await kalshiGet<KalshiMarketSnapshot>(`/markets/${encodeURIComponent(ticker)}`, {}, creds);
    const market = snapshot.market;
    if (!market) return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: "Kalshi market snapshot unavailable" };
    if (market.status && !["open", "active"].includes(market.status)) {
      return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: `Kalshi market is ${market.status}` };
    }

    const yesAsk = centsFromMaybeDollars(market.yes_ask, market.yes_ask_dollars);
    const yesBid = centsFromMaybeDollars(market.yes_bid, market.yes_bid_dollars);
    const priceCents = yesNo === "yes" ? yesAsk : yesBid == null ? null : 100 - yesBid;
    const availableContracts = Number(yesNo === "yes" ? market.yes_ask_size_fp : market.yes_bid_size_fp);
    if (priceCents == null) return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: "Kalshi top-of-book price unavailable" };
    if (priceCents > req.limitPriceCents) {
      return { ok: false, priceCents, averagePriceCents: priceCents, availableContracts: 0, reason: `Kalshi top-of-book moved above limit (${priceCents}c > ${req.limitPriceCents}c)` };
    }
    const available = Number.isFinite(availableContracts) ? Math.max(0, availableContracts) : 0;
    return {
      ok: available + 1e-9 >= req.sizeContracts,
      priceCents,
      averagePriceCents: priceCents,
      availableContracts: Math.min(available, req.sizeContracts),
      levels: available > 0 ? [{ priceCents, contracts: available }] : [],
      reason: available + 1e-9 >= req.sizeContracts ? undefined : `Kalshi top-of-book size ${available.toFixed(2)} < ${req.sizeContracts}`,
    };
  } catch (e) {
    return { ok: false, priceCents: req.limitPriceCents, averagePriceCents: req.limitPriceCents, availableContracts: 0, reason: `Kalshi market check failed: ${String(e).slice(0, 120)}` };
  }
}

export async function checkKalshiFillability(req: OrderRequest, creds?: KalshiCreds): Promise<{ ok: boolean; reason?: string }> {
  const quote = await quoteKalshiOrder(req, creds);
  return { ok: quote.ok, reason: quote.reason };
}

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

  quoteOrder(req: OrderRequest): Promise<ExecutableOrderQuote> {
    return quoteKalshiOrder(req, this.creds);
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
      client_order_id: req.clientOrderId ?? crypto.randomUUID(),
      side: isYes ? "bid" : "ask",
      count: req.sizeContracts.toFixed(2), // fixed-point count, e.g. "10.00"
      price: yesPriceDollars.toFixed(4), // YES price in dollars
      time_in_force: "immediate_or_cancel", // cross now; cancel any unfilled remainder
      self_trade_prevention_type: "taker_at_cross",
    };

    try {
      const resp = await kalshiPost<KalshiV2OrderResp>("/portfolio/events/orders", body, this.creds);
      const orderId = resp.order_id ?? null;
      const filled = Math.floor((Number(resp.fill_count) || 0) * 100) / 100;
      // average_fill_price is the YES fill price; convert back to the outcome's cost.
      const avgYes = Number(resp.average_fill_price);
      const avgPriceCents = Number.isFinite(avgYes) && avgYes > 0
        ? Math.round((isYes ? avgYes : 1 - avgYes) * 100)
        : req.limitPriceCents;
      const status = filled >= req.sizeContracts ? "filled" : filled > 0 ? "partial" : "unfilled";
      return { ok: filled > 0, orderId, filledContracts: filled, avgPriceCents, status, raw: resp };
    } catch (e) {
      // A 409 means Kalshi has already consumed this idempotency key. Never classify that
      // as a terminal zero-fill until the existing order has been looked up: the POST
      // response may have been lost after the matching engine accepted or filled it.
      if (/\b409\b|order_already_exists|already exists/i.test(String(e)) && req.clientOrderId) {
        const existing = await this.recoverOrder(req);
        if (existing) return existing;
        return {
          ok: false,
          orderId: null,
          filledContracts: 0,
          avgPriceCents: req.limitPriceCents,
          status: "pending",
          error: `Kalshi duplicate client order id; existing order could not yet be reconciled: ${String(e)}`,
        };
      }
      return reject(req, String(e));
    }
  }

  async recoverOrder(req: OrderRequest): Promise<OrderResult | null> {
    if (!this.supportsLive() || !req.clientOrderId || !req.nativeMarketId) return null;
    try {
      // Kalshi documents client_order_id as its duplicate-order key. Query the account's
      // recent orders for this ticker and match that identifier; this is read-only and
      // never retries the original POST.
      const response = await kalshiGet<KalshiOrdersResponse>(
        `/portfolio/orders?ticker=${encodeURIComponent(req.nativeMarketId)}&limit=100`,
        {},
        this.creds
      );
      const order = response.orders?.find((candidate) => candidate.client_order_id === req.clientOrderId);
      if (!order) return null;
      const filled = Math.floor((Number(order.fill_count_fp ?? order.fill_count) || 0) * 100) / 100;
      const isYes = (req.nativeSide ?? "").toLowerCase() === "yes";
      const yesPrice = Number(order.average_fill_price ?? order.yes_price_dollars);
      const noPrice = Number(order.no_price_dollars);
      const avgPriceCents = Number.isFinite(yesPrice) && yesPrice > 0
        ? Math.round((isYes ? yesPrice : 1 - yesPrice) * 100)
        : Number.isFinite(noPrice) && noPrice > 0
          ? Math.round((isYes ? 1 - noPrice : noPrice) * 100)
          : req.limitPriceCents;
      const venueStatus = (order.status ?? "").toLowerCase();
      const status = filled + 1e-9 >= req.sizeContracts
        ? "filled"
        : filled > 0
          ? "partial"
          : venueStatus === "resting" || venueStatus === "pending"
            ? "pending"
            : "unfilled";
      return {
        ok: filled > 0,
        orderId: order.order_id ?? null,
        filledContracts: filled,
        avgPriceCents,
        status,
        raw: order,
      };
    } catch {
      return null;
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
