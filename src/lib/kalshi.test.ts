import { describe, expect, it } from "vitest";
import { eventTimingMatchesGame, extractSpreadLine } from "./kalshi";

describe("Kalshi game timing", () => {
  it("accepts an expected game end a few hours after tipoff", () => {
    expect(
      eventTimingMatchesGame("2026-07-17T22:00:00Z", [
        { expected_expiration_time: "2026-07-18T01:00:00Z" },
      ])
    ).toBe(true);
  });

  it("rejects a same-team event scheduled for the next day", () => {
    expect(
      eventTimingMatchesGame("2026-07-17T22:00:00Z", [
        { expected_expiration_time: "2026-07-19T01:00:00Z" },
      ])
    ).toBe(false);
  });
});

describe("Kalshi spread parsing", () => {
  it("does not mistake 76ers for the spread line", () => {
    expect(
      extractSpreadLine({
        title: "Philadelphia 76ers win by over 4.5 points?",
        yes_sub_title: "Philadelphia 76ers win by over 4.5 points",
      })
    ).toBe(4.5);
  });
});
