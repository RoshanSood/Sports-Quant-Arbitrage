import { describe, it, expect } from "vitest";
import {
  centsToDollars,
  decimalOddsFromCents,
  equalProfitSizing,
  executedEconomics,
  grossEdge,
  impliedProbFromCents,
  netEdge,
  sxbetMinStakeScale,
  totalCostCents,
} from "./arbMath";

describe("arbMath — conversions", () => {
  it("cents → dollars", () => {
    expect(centsToDollars(47)).toBe(0.47);
  });
  it("implied probability from cents", () => {
    expect(impliedProbFromCents(44)).toBe(0.44);
  });
  it("decimal odds from cents (44c → 2.273)", () => {
    expect(decimalOddsFromCents(44)).toBeCloseTo(2.273, 3);
  });
});

describe("arbMath — binary edge (manual §17)", () => {
  it("OVER 41c + UNDER 51c → cost 92c, gross ~8.70%", () => {
    const cost = totalCostCents([41, 51]);
    expect(cost).toBe(92);
    expect(grossEdge(cost)).toBeCloseTo(0.087, 3);
  });

  it("OVER 55c + UNDER 50c → cost 105c, gross negative (no arb)", () => {
    const cost = totalCostCents([55, 50]);
    expect(cost).toBe(105);
    expect(grossEdge(cost)).toBeLessThan(0);
  });

  it("net edge subtracts fees and slippage", () => {
    expect(netEdge(0.087, 0.02, 0.002)).toBeCloseTo(0.065, 3);
  });
});

describe("arbMath — equal-profit sizing", () => {
  it("splits a $50 cap so payout is equal and profit is positive", () => {
    const plan = equalProfitSizing(
      [
        { venueId: "kalshi", priceCents: 51 },
        { venueId: "polymarket", priceCents: 41 },
      ],
      50
    );
    // priceSum 0.92 → totalStake ≈ maxStake, guaranteedPayout ≈ 50/0.92
    expect(plan.totalStake).toBeCloseTo(50, 0);
    expect(plan.guaranteedPayout).toBeCloseTo(54.35, 1);
    expect(plan.expectedProfit).toBeGreaterThan(0);
    // legs sum to the total stake
    expect(plan.legSizes.kalshi + plan.legSizes.polymarket).toBeCloseTo(plan.totalStake, 1);
  });

  it("returns a zero plan when maxStake is 0", () => {
    const plan = equalProfitSizing([{ venueId: "kalshi", priceCents: 50 }], 0);
    expect(plan.totalStake).toBe(0);
    expect(plan.expectedProfit).toBe(0);
  });
});

describe("arbMath — executedEconomics (portfolio truth of the fill)", () => {
  it("uses the ACTUAL executed prices, not the pre-fill quote", () => {
    // Polymarket filled at 79.8c (not the detected 79c), Kalshi Under at 4c — 4 contracts each.
    const e = executedEconomics([
      { priceCents: 79.8, size: 4, feeCents: 0 },
      { priceCents: 4, size: 4, feeCents: 0 },
    ]);
    expect(e.totalCost).toBeCloseTo(3.35, 2); // 4×0.798 + 4×0.04 = 3.192 + 0.16
    expect(e.guaranteedPayout).toBe(4); // matched contracts × $1
    expect(e.expectedProfit).toBeCloseTo(0.65, 2); // 4 − 3.352
    expect(e.netEdge).toBeCloseTo(0.65 / 3.35, 3);
  });

  it("subtracts fees from the executed profit", () => {
    const e = executedEconomics([
      { priceCents: 50, size: 10, feeCents: 12 }, // $0.12 fee on this leg
      { priceCents: 45, size: 10, feeCents: 0 },
    ]);
    // cost 5.00 + 4.50 = 9.50, payout 10, profit 10 − 9.50 − 0.12 = 0.38
    expect(e.totalCost).toBeCloseTo(9.5, 2);
    expect(e.expectedProfit).toBeCloseTo(0.38, 2);
  });

  it("guaranteed payout = the MATCHED (min) contracts when legs fill unequally", () => {
    // Over leg over-filled (4.1) vs Under leg (4.0): only 4.0 are hedged.
    const e = executedEconomics([
      { priceCents: 77, size: 4.1, feeCents: 0 },
      { priceCents: 4, size: 4, feeCents: 0 },
    ]);
    expect(e.guaranteedPayout).toBe(4); // the min, not 4.1
    // cost reflects the full 4.1 paid on the over leg
    expect(e.totalCost).toBeCloseTo(4.1 * 0.77 + 4 * 0.04, 2);
  });

  it("empty legs → all zero", () => {
    expect(executedEconomics([])).toEqual({ totalCost: 0, guaranteedPayout: 0, expectedProfit: 0, netEdge: 0 });
  });
});

describe("arbMath — sxbetMinStakeScale (SX.bet $1 minimum order)", () => {
  const applyScale = (
    legs: { venueId: string; priceCents: number; size: number }[],
    scale: number
  ) => legs.map((l) => ({ ...l, size: Math.round(l.size * scale * 1e4) / 1e4 }));

  it("scales the whole arb up so the SX leg clears $1 (68c leg, 1 contract → $0.68)", () => {
    const legs = [
      { venueId: "polymarket", priceCents: 30, size: 1 },
      { venueId: "sxbet", priceCents: 68, size: 1 },
    ];
    const { scale, floorTotalUsd } = sxbetMinStakeScale(legs, 1);
    expect(scale).toBeGreaterThan(1);
    // After scaling, the SX leg stakes >= $1 and the hedge ratio is preserved.
    const scaled = applyScale(legs, scale);
    const sx = scaled.find((l) => l.venueId === "sxbet")!;
    expect(centsToDollars(sx.priceCents) * sx.size).toBeGreaterThanOrEqual(1);
    // Both legs kept equal contract counts (still a valid hedge).
    expect(scaled[0].size).toBeCloseTo(scaled[1].size, 4);
    expect(floorTotalUsd).toBeCloseTo(1.44, 2); // 1.4706 ctr × (0.30 + 0.68)
  });

  it("no size-up when the SX leg already stakes >= $1", () => {
    const legs = [
      { venueId: "polymarket", priceCents: 30, size: 2 },
      { venueId: "sxbet", priceCents: 68, size: 2 }, // $1.36
    ];
    expect(sxbetMinStakeScale(legs, 1)).toEqual({ scale: 1, floorTotalUsd: 0 });
  });

  it("no SX leg → no change", () => {
    const legs = [
      { venueId: "polymarket", priceCents: 30, size: 1 },
      { venueId: "kalshi", priceCents: 68, size: 1 },
    ];
    expect(sxbetMinStakeScale(legs, 1)).toEqual({ scale: 1, floorTotalUsd: 0 });
  });

  it("thin/cheap SX leg needs a large scale (5c leg, 1 contract → $0.05)", () => {
    const legs = [
      { venueId: "polymarket", priceCents: 90, size: 1 },
      { venueId: "sxbet", priceCents: 5, size: 1 },
    ];
    const { scale } = sxbetMinStakeScale(legs, 1);
    expect(scale).toBeCloseTo(20, 4); // $1 / $0.05
  });
});
