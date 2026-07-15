import { describe, it, expect } from "vitest";
import { computeFees, kalshiFee, kalshiFeePerContract, polymarketFee } from "./feeEngine";
import type { ArbLeg } from "@/types/arbitrage";

function leg(venueId: string, priceCents: number, size: number): ArbLeg {
  return {
    venueId,
    marketId: `${venueId}:x:total:6.5:over`,
    outcome: "over",
    priceCents,
    decimalOdds: 100 / priceCents,
    impliedProbability: priceCents / 100,
    size,
    feeCents: 0,
  };
}

describe("feeEngine — Kalshi tier formula (manual §8)", () => {
  it("P=0.55, tier 0.07 → $0.017325 per contract", () => {
    expect(kalshiFeePerContract(0.55, 0.07)).toBeCloseTo(0.017325, 6);
  });
  it("clamps probability to [0,1]", () => {
    expect(kalshiFeePerContract(1.5)).toBe(0);
    expect(kalshiFeePerContract(-0.2)).toBe(0);
  });
  it("rounds the aggregate taker fee upward", () => {
    expect(kalshiFee(40, 0.55)).toBe(0.7);
    expect(kalshiFee(0, 0.55)).toBe(0);
  });
});

describe("feeEngine — Polymarket sports taker formula", () => {
  it("uses contracts × 0.05 × p × (1-p)", () => {
    expect(polymarketFee(100, 0.5)).toBeCloseTo(1.25, 5);
    expect(polymarketFee(100, 0.3)).toBeCloseTo(1.05, 5);
  });
});

describe("feeEngine — per-venue model routing", () => {
  it("routes kalshi/polymarket/sxbet to the right models", () => {
    const fees = computeFees([leg("kalshi", 55, 40), leg("polymarket", 44, 40), leg("sxbet", 50, 40)]);
    expect(fees[0].model).toBe("kalshi_tier");
    expect(fees[1].model).toBe("polymarket_sports");
    expect(fees[2].model).toBe("sxbet_flat");
    // Kalshi raw fee is $0.693; the published aggregate charge rounds upward.
    expect(fees[0].feeCents).toBe(70);
    expect(fees[1].feeCents).toBeCloseTo(0.05 * 0.44 * 0.56 * 40 * 100, 4);
    // SX.bet taker fee is zero by default
    expect(fees[2].feeCents).toBe(0);
  });
});
