import { describe, expect, it } from "vitest";
import { bestPrices, type SxOrder } from "./sxbet";

function order(makerOne: boolean, makerProbability: number, remaining = 1_000_000): SxOrder {
  return {
    marketHash: "0x1",
    percentageOdds: String(makerProbability * 1e20),
    totalBetSize: String(remaining),
    fillAmount: "0",
    isMakerBettingOutcomeOne: makerOne,
  };
}

describe("SX executable liquidity", () => {
  it("converts maker size to odds-dependent taker space and aggregates a price level", () => {
    const prices = bestPrices([order(false, 0.6), order(false, 0.6), order(true, 0.55)]);
    expect(prices?.o1Cents).toBe(40);
    expect(prices?.o1LiqUsd).toBeCloseTo(2 * (0.4 / 0.6), 6);
    expect(prices?.o2LiqUsd).toBeCloseTo(0.45 / 0.55, 6);
  });
});
