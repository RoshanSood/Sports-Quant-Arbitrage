import { describe, expect, it } from "vitest";
import { predictAmountToContracts } from "./predictFunAdapter";

describe("predict.fun confirmed fill amount parsing", () => {
  it("parses 18-decimal on-chain amounts", () => {
    expect(predictAmountToContracts("7000000000000000000")).toBe(7);
  });

  it("preserves legacy decimal and small integer amounts", () => {
    expect(predictAmountToContracts("6.25")).toBe(6.25);
    expect(predictAmountToContracts("6")).toBe(6);
  });

  it("never invents a fill from missing or invalid data", () => {
    expect(predictAmountToContracts(undefined)).toBe(0);
    expect(predictAmountToContracts("not-a-number")).toBe(0);
  });
});
