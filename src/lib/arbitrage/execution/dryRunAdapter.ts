// Dry-run executor. Runs the same per-leg code path as a live adapter without
// hitting a venue. Quote refresh already proved the full size at the limit, so the
// paper fill is deterministic and all-or-nothing like the live FOK contract.

import crypto from "node:crypto";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

export class DryRunAdapter implements ExecutionAdapter {
  constructor(public id: string) {}

  supportsLive(): boolean {
    return false; // dry-run never places a real order
  }

  supportsFillOrKill(): boolean {
    return true;
  }

  async getBalanceUsd(): Promise<number | null> {
    return null;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const oid = `dry-${req.venueId}-${crypto.randomUUID()}`;
    return { ok: true, orderId: oid, filledContracts: req.sizeContracts, avgPriceCents: req.limitPriceCents, status: "filled" };
  }
}
