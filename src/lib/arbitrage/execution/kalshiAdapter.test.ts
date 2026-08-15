import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/kalshiAuth", () => ({
  isKalshiConfigured: () => true,
  kalshiGet: auth.get,
  kalshiPost: auth.post,
}));

import { KalshiExecutionAdapter } from "./kalshiAdapter";
import type { OrderRequest } from "./types";

const request: OrderRequest = {
  venueId: "kalshi",
  marketId: "kalshi:test",
  nativeMarketId: "KX-TEST",
  nativeSide: "no",
  outcome: "away",
  sizeContracts: 7,
  limitPriceCents: 82,
  clientOrderId: "recovery-attempt-id",
};

describe("Kalshi duplicate id reconciliation", () => {
  beforeEach(() => {
    auth.get.mockReset();
    auth.post.mockReset();
  });

  it("turns a 409 into the existing order's authoritative fill", async () => {
    auth.post.mockRejectedValue(new Error('Kalshi 409 Conflict: {"code":"order_already_exists"}'));
    auth.get.mockResolvedValue({
      orders: [{
        order_id: "existing-order",
        client_order_id: request.clientOrderId,
        fill_count_fp: "7.00",
        average_fill_price: "0.1800",
        status: "executed",
      }],
    });

    const result = await new KalshiExecutionAdapter({} as never).placeOrder(request);
    expect(result).toMatchObject({
      ok: true,
      orderId: "existing-order",
      filledContracts: 7,
      avgPriceCents: 82,
      status: "filled",
    });
    expect(auth.post).toHaveBeenCalledTimes(1);
    expect(auth.get).toHaveBeenCalledTimes(1);
  });

  it("fails closed as pending when a duplicate cannot yet be found", async () => {
    auth.post.mockRejectedValue(new Error("409 order_already_exists"));
    auth.get.mockResolvedValue({ orders: [] });

    const result = await new KalshiExecutionAdapter({} as never).placeOrder(request);
    expect(result).toMatchObject({ ok: false, filledContracts: 0, status: "pending" });
    expect(result.error).toContain("could not yet be reconciled");
  });
});
