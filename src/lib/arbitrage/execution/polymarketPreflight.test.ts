import { describe, it, expect } from "vitest";
import { polymarketAnchorCeiling, isPolymarketFokFailure } from "./executor";
import type { OrderRequest, OrderResult } from "./types";

function req(over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    venueId: "polymarket",
    marketId: "polymarket:1:total:8.5:over",
    nativeMarketId: "slug",
    nativeSide: "yes",
    outcome: "over",
    sizeContracts: 4,
    limitPriceCents: 47,
    ...over,
  };
}
function result(over: Partial<OrderResult> = {}): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: 47, status: "rejected", ...over };
}

describe("polymarketAnchorCeiling", () => {
  it("lets the anchor walk up to +8c above the detected price", () => {
    expect(polymarketAnchorCeiling(47)).toBe(55);
  });
  it("never exceeds 99c", () => {
    expect(polymarketAnchorCeiling(95)).toBe(99);
  });
});

describe("isPolymarketFokFailure — routes preflight failures into retry", () => {
  it("matches a preflight 'no live ask depth' failure (previously missed → no retry)", () => {
    expect(isPolymarketFokFailure(req(), result({ error: "Polymarket live book preflight failed: no live ask depth at 48.00c or better" }))).toBe(true);
  });
  it("still matches a killed FOK order", () => {
    expect(isPolymarketFokFailure(req(), result({ error: "order couldn't be fully filled. FOK orders are fully filled or killed.", status: "unfilled" }))).toBe(true);
  });
  it("is false for a fully-filled order", () => {
    expect(isPolymarketFokFailure(req({ sizeContracts: 4 }), result({ ok: true, filledContracts: 4, status: "filled" }))).toBe(false);
  });
  it("is false for non-Polymarket venues", () => {
    expect(isPolymarketFokFailure(req({ venueId: "kalshi" }), result({ error: "no live ask depth" }))).toBe(false);
  });
});
