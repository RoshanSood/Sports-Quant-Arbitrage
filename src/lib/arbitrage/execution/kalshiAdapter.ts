// Kalshi live execution adapter (manual §12). Places real orders via the RSA-PSS
// signed POST /portfolio/orders, using either per-request credentials (forwarded from
// the user's browser) or the server env. Emulates immediate-or-cancel: cross the
// spread, poll the order, and CANCEL any un-filled remainder so we never leave a
// resting (naked) order. Guarded upstream by the execution gate.

import crypto from "node:crypto";
import { isKalshiConfigured, kalshiDelete, kalshiGet, kalshiPost, type KalshiCreds } from "@/lib/kalshiAuth";
import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

type KalshiBalance = { balance?: number }; // cents
type KalshiOrder = { order_id?: string; status?: string; taker_fill_count?: number; remaining_count?: number };
type KalshiOrderResp = { order?: KalshiOrder };

function filledCount(o: KalshiOrder | undefined, requested: number): number {
  if (!o) return 0;
  if (typeof o.taker_fill_count === "number") return o.taker_fill_count;
  if (typeof o.remaining_count === "number") return Math.max(0, requested - o.remaining_count);
  return o.status === "executed" ? requested : 0;
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

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.supportsLive()) {
      return reject(req, "Kalshi credentials not configured");
    }
    const ticker = req.nativeMarketId;
    const side = (req.nativeSide ?? "").toLowerCase();
    if (!ticker || (side !== "yes" && side !== "no")) {
      return reject(req, "missing Kalshi native ticker/side — live order not wired for this leg");
    }

    const body: Record<string, unknown> = {
      ticker,
      action: "buy",
      side,
      count: req.sizeContracts,
      type: "limit",
      client_order_id: crypto.randomUUID(),
      [side === "yes" ? "yes_price" : "no_price"]: req.limitPriceCents,
    };

    try {
      const resp = await kalshiPost<KalshiOrderResp>("/portfolio/orders", body, this.creds);
      const order = resp.order ?? {};
      const orderId = order.order_id ?? null;
      let filled = filledCount(order, req.sizeContracts);

      // If it didn't fully fill immediately, re-read once, then cancel the remainder
      // (IOC emulation) so no naked resting order is left on the book.
      if (orderId && filled < req.sizeContracts) {
        try {
          const got = await kalshiGet<KalshiOrderResp>(`/portfolio/orders/${orderId}`, {}, this.creds);
          filled = filledCount(got.order, req.sizeContracts);
          if (filled < req.sizeContracts && got.order?.status !== "canceled") {
            await kalshiDelete(`/portfolio/orders/${orderId}`, this.creds).catch((e) => console.error("[exec/kalshi] cancel failed:", e));
          }
        } catch (e) {
          console.error("[exec/kalshi] order poll failed:", e);
        }
      }

      const status = filled >= req.sizeContracts ? "filled" : filled > 0 ? "partial" : "unfilled";
      return { ok: filled > 0, orderId, filledContracts: filled, avgPriceCents: req.limitPriceCents, status, raw: resp };
    } catch (e) {
      return reject(req, String(e));
    }
  }

  // Re-read the order to confirm the fill (Kalshi settles synchronously; IOC leaves no
  // resting order, so a zero-fill order is a genuine failure).
  async confirmFill(orderId: string, req: OrderRequest): Promise<FillConfirmation> {
    try {
      const got = await kalshiGet<KalshiOrderResp>(`/portfolio/orders/${orderId}`, {}, this.creds);
      const filled = filledCount(got.order, req.sizeContracts);
      if (filled > 0) return { status: "settled", filledContracts: filled };
      return { status: "failed", filledContracts: 0 };
    } catch {
      return { status: "unknown" };
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
