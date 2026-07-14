import { describe, it, expect } from "vitest";
import {
  centsToDollars,
  decimalOddsFromCents,
  equalProfitSizing,
  grossEdge,
  impliedProbFromCents,
  netEdge,
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
