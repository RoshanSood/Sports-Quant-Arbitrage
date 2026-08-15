import { describe, it, expect } from "vitest";
import { computeFees, kalshiFeePerContract, polymarketFee } from "./feeEngine";
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
});

describe("feeEngine — Polymarket probability curve", () => {
  it("uses contracts * rate * p * (1-p)", () => {
    expect(polymarketFee(4, 0.88)).toBeCloseTo(0.012672, 6);
  });
});

describe("feeEngine — per-venue model routing", () => {
  it("routes kalshi/polymarket/sxbet to the right models", () => {
    const fees = computeFees([leg("kalshi", 55, 40), leg("polymarket", 44, 40), leg("sxbet", 50, 40)]);
    expect(fees[0].model).toBe("kalshi_tier");
    expect(fees[1].model).toBe("polymarket_curve");
    expect(fees[2].model).toBe("sxbet_flat");
    // Kalshi fee = 0.07*0.55*0.45*40 contracts ≈ $0.693 → ~69c
    expect(fees[0].feeCents).toBeCloseTo(0.07 * 0.55 * 0.45 * 40 * 100, 0);
    // SX.bet taker fee is zero by default
    expect(fees[2].feeCents).toBe(0);
  });
});
