import { describe, it, expect } from "vitest";
import { opportunityMarketType } from "./ingest";

// The targeted pre-trade refresh derives which market type to re-fetch from the
// opportunity id. The id is `${eventKey}:${marketType}:${line}` and the eventKey itself
// contains colons (sport:league:teams:isoBucket), so the derivation must read the
// second-to-last colon segment — not split naively.
describe("opportunityMarketType", () => {
  const bucket = "2026-07-29T19:00:00.000Z"; // ISO bucket has colons

  it("reads the market type from a totals opportunity id", () => {
    expect(opportunityMarketType(`baseball:mlb:reds|phillies:${bucket}:total:8.5`)).toBe("total");
  });

  it("reads the market type from a moneyline opportunity id (line 0)", () => {
    expect(opportunityMarketType(`soccer:mls:galaxy|miami:${bucket}:moneyline:0`)).toBe("moneyline");
  });

  it("reads the market type from a spread opportunity id (negative line)", () => {
    expect(opportunityMarketType(`baseball:mlb:reds|phillies:${bucket}:spread:-1.5`)).toBe("spread");
  });

  it("returns null when no known market type is present", () => {
    expect(opportunityMarketType("garbage")).toBeNull();
    expect(opportunityMarketType(`baseball:mlb:reds|phillies:${bucket}:futures:0`)).toBeNull();
  });
});
