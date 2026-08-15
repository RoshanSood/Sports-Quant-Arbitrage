import { afterEach, describe, expect, it } from "vitest";
import {
  clearVenueFailure,
  isDeterministicVenueFailure,
  recordVenueFailure,
  resetVenueFailureCircuits,
  venueCircuitBlocker,
} from "./venueCircuitBreaker";

describe("venue deterministic-failure circuit breaker", () => {
  afterEach(resetVenueFailureCircuits);

  it("opens for SX insufficient-token failures and expires after the cooldown", () => {
    expect(recordVenueFailure("sxbet", "TAKER_INSUFFICIENT_BASE_TOKEN", 1_000, 60_000)).toBe(true);
    expect(venueCircuitBlocker("sxbet", 1_001)).toContain("cooldown active");
    expect(venueCircuitBlocker("sxbet", 61_000)).toBeNull();
  });

  it("does not open for transient price, depth, or network failures", () => {
    for (const error of ["ask moved above limit", "depth fell below 6", "ECONNRESET"]) {
      expect(isDeterministicVenueFailure(error)).toBe(false);
      expect(recordVenueFailure("sxbet", error)).toBe(false);
    }
    expect(venueCircuitBlocker("sxbet")).toBeNull();
  });

  it("closes immediately after a successful venue result", () => {
    recordVenueFailure("sxbet", "insufficient balance", 1_000, 60_000);
    clearVenueFailure("sxbet");
    expect(venueCircuitBlocker("sxbet", 1_001)).toBeNull();
  });
});
