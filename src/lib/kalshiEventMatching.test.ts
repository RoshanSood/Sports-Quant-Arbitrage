import { describe, expect, it } from "vitest";
import { eventTimingMatchesGame } from "./kalshi";

describe("eventTimingMatchesGame", () => {
  it("matches the Kalshi event whose expected end follows the game start", () => {
    expect(
      eventTimingMatchesGame("2026-07-18T00:05:00Z", [
        { expected_expiration_time: "2026-07-18T03:05:00Z" },
      ])
    ).toBe(true);
  });

  it("rejects the next day's event when the same teams play consecutively", () => {
    expect(
      eventTimingMatchesGame("2026-07-18T00:05:00Z", [
        { expected_expiration_time: "2026-07-18T21:20:00Z" },
      ])
    ).toBe(false);
  });

  it("rejects the prior day's event for the later game", () => {
    expect(
      eventTimingMatchesGame("2026-07-18T20:10:00Z", [
        { expected_expiration_time: "2026-07-18T03:10:00Z" },
      ])
    ).toBe(false);
  });

  it("keeps backward compatibility when Kalshi omits timing metadata", () => {
    expect(eventTimingMatchesGame("2026-07-18T20:10:00Z", [{}])).toBe(true);
  });
});
