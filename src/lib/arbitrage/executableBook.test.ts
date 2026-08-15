import { describe, expect, it } from "vitest";
import { fillAskLevels, normalizeAskLevels } from "./executableBook";

describe("executable ask pricing", () => {
  it("walks past microscopic top-of-book dust to price one real contract", () => {
    const fill = fillAskLevels([
      { priceCents: 25, contracts: 4.5e-13 },
      { priceCents: 34, contracts: 10 },
    ], 1);
    expect(fill?.worstPriceCents).toBe(34);
    expect(fill?.averagePriceCents).toBeCloseTo(34, 8);
  });

  it("walks multiple levels and exposes both average cost and safe limit", () => {
    const fill = fillAskLevels([
      { priceCents: 48, contracts: 0.25 },
      { priceCents: 50, contracts: 1 },
    ], 1);
    expect(fill?.averagePriceCents).toBe(49.5);
    expect(fill?.worstPriceCents).toBe(50);
  });

  it("merges duplicate prices and rejects insufficient depth", () => {
    expect(normalizeAskLevels([
      { priceCents: 40, contracts: 0.4 },
      { priceCents: 40, contracts: 0.3 },
      { priceCents: 0, contracts: 10 },
    ])).toEqual([{ priceCents: 40, contracts: 0.7 }]);
    expect(fillAskLevels([{ priceCents: 40, contracts: 0.99 }], 1)).toBeNull();
  });
});
