import { describe, expect, it } from "vitest";
import { toExecutableCents } from "./kalshi";

describe("Kalshi arbitrage prices", () => {
  it("preserves subpenny fixed-point quotes", () => {
    expect(toExecutableCents(0.055)).toBe(5.5);
    expect(toExecutableCents(1 - 0.055)).toBe(94.5);
    expect(toExecutableCents(0.3301)).toBe(33.01);
  });
});
