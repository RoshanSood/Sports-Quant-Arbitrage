import { describe, expect, it } from "vitest";
import { polymarketFokBuyAmount } from "./polymarketAdapter";

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
