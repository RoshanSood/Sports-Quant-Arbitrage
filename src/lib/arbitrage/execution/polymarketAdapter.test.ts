import { describe, expect, it } from "vitest";
import { polymarketFillQuoteFromAsks, polymarketFokBuyAmount } from "./polymarketAdapter";

describe("Polymarket FOK buy sizing", () => {
  it("rounds the USDC maker amount to cents", () => {
    expect(polymarketFokBuyAmount(2.002, 99.9)).toBe(2);
    expect(polymarketFokBuyAmount(3.50877, 57)).toBe(2);
  });

  it("keeps exact cent-sized arb stakes unchanged", () => {
    expect(polymarketFokBuyAmount(4, 50)).toBe(2);
    expect(polymarketFokBuyAmount(10, 50)).toBe(5);
  });
});

describe("Polymarket FOK retry quote", () => {
  it("walks asks up to the limit and reports fillable contracts", () => {
    const quote = polymarketFillQuoteFromAsks(
      [
        { price: "0.42", size: "1.5" },
        { price: "0.43", size: "3" },
        { price: "0.45", size: "10" },
      ],
      43,
      4
    );

    expect(quote).toEqual({
      limitPriceCents: 43,
      avgPriceCents: 42.625,
      availableContracts: 4,
      availableStakeUsd: 1.705,
    });
  });

  it("resizes down when only partial depth is available inside the retry limit", () => {
    const quote = polymarketFillQuoteFromAsks([{ price: "0.51", size: "1.25" }], 52, 4);

    expect(quote?.availableContracts).toBe(1.25);
    expect(quote?.limitPriceCents).toBe(51);
    expect(quote?.availableStakeUsd).toBeCloseTo(0.6375);
  });

  it("returns null when no ask is available at or below the limit", () => {
    expect(polymarketFillQuoteFromAsks([{ price: "0.54", size: "8" }], 53, 4)).toBeNull();
  });
});
