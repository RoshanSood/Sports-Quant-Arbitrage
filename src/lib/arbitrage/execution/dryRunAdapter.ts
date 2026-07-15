// Dry-run executor. Runs the SAME per-leg code path as a live adapter but simulates
// the fill (latency, slippage, occasional partial/reject) instead of hitting a venue.
// This is what every venue uses unless the full live gate passes.

import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

function slip(cents: number): number {
  return Math.min(99, cents + Math.round(Math.random())); // ≤1¢ adverse depth walk
}

export class DryRunAdapter implements ExecutionAdapter {
  constructor(public id: string) {}

  supportsLive(): boolean {
    return false; // dry-run never places a real order
  }

  async getBalanceUsd(): Promise<number | null> {
    return null;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const roll = Math.random();
    const oid = `dry-${req.venueId}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    // ~4% reject (hedge-failure source), ~6% partial, else full fill.
    if (roll < 0.04) {
      return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error: "simulated reject" };
    }
    if (roll < 0.1) {
      const filled = Math.floor(req.sizeContracts * 0.5);
      return { ok: true, orderId: oid, filledContracts: filled, avgPriceCents: slip(req.limitPriceCents), status: filled > 0 ? "partial" : "unfilled" };
    }
    return { ok: true, orderId: oid, filledContracts: req.sizeContracts, avgPriceCents: slip(req.limitPriceCents), status: "filled" };
  }

  // Simulated finality — a dry-run order "settles" immediately.
  async confirmFill(_orderId: string, req: OrderRequest): Promise<FillConfirmation> {
    void _orderId;
    return { status: "settled", filledContracts: req.sizeContracts };
  }
}
