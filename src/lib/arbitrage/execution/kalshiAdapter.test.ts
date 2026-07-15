import { describe, expect, it } from "vitest";
import type { OrderRequest } from "./types";
import { buildKalshiFokOrder } from "./kalshiAdapter";

function order(nativeSide: "yes" | "no", limitPriceCents: number): OrderRequest {
  return {
    venueId: "kalshi",
    marketId: "kalshi:game:moneyline:home",
    nativeMarketId: "KXMLBGAME-HOME",
    nativeSide,
    outcome: "home",
    limitPriceCents,
    sizeContracts: 12.5,
  };
}

describe("buildKalshiFokOrder", () => {
  it("builds a YES bid using fixed-point dollars", () => {
    expect(buildKalshiFokOrder(order("yes", 56), "client-1")).toEqual({
      ticker: "KXMLBGAME-HOME",
      side: "bid",
      count: "12.50",
      price: "0.5600",
      client_order_id: "client-1",
      time_in_force: "fill_or_kill",
      self_trade_prevention_type: "taker_at_cross",
      post_only: false,
      cancel_order_on_pause: true,
    });
  });

  it("maps a NO purchase to an ask on the YES book", () => {
    const body = buildKalshiFokOrder(order("no", 37), "client-2");
    expect(body?.side).toBe("ask");
    expect(body?.price).toBe("0.6300");
  });

  it("rejects legs without a native side", () => {
    expect(buildKalshiFokOrder({ ...order("yes", 56), nativeSide: undefined })).toBeNull();
  });

  it("rejects invalid price and size limits", () => {
    expect(buildKalshiFokOrder(order("yes", 100))).toBeNull();
    expect(buildKalshiFokOrder({ ...order("yes", 56), sizeContracts: 0 })).toBeNull();
  });
});
