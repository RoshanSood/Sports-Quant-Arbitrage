import { describe, expect, it } from "vitest";
import { parsePredictFunFilledContracts } from "./predictFunAdapter";

describe("parsePredictFunFilledContracts", () => {
  it("reads amountFilled from predict.fun order queries", () => {
    const out = parsePredictFunFilledContracts({ data: { amountFilled: "4.9", status: "OPEN" } }, 5);
    expect(out).toEqual({ filled: 4.9, status: "partial" });
  });

  it("normalizes 18-decimal share amounts", () => {
    const out = parsePredictFunFilledContracts({ data: { amountFilled: "4900000000000000000" } }, 5);
    expect(out).toEqual({ filled: 4.9, status: "partial" });
  });

  it("falls back to filled status when no amount is present", () => {
    const out = parsePredictFunFilledContracts({ data: { status: "FILLED" } }, 5);
    expect(out).toEqual({ filled: 5, status: "filled" });
  });
});
