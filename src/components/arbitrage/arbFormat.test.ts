import { describe, expect, it } from "vitest";
import { formatVenueList, venueAbbr, venueDisplayName } from "./arbFormat";

describe("venue display formatting", () => {
  it("uses the requested venue abbreviations", () => {
    expect(venueAbbr("polymarket")).toBe("P");
    expect(venueAbbr("predictfun")).toBe("PF");
    expect(venueAbbr("sxbet")).toBe("SX");
    expect(venueAbbr("cloudbet")).toBe("CB");
    expect(venueAbbr("kalshi")).toBe("K");
  });

  it("formats venue lists for logs", () => {
    expect(formatVenueList(["polymarket", "predictfun", "sxbet", "cloudbet", "kalshi"])).toBe("P -> PF -> SX -> CB -> K");
  });

  it("uses full names where the UI needs readable labels", () => {
    expect(venueDisplayName("cloudbet")).toBe("CloudBet");
    expect(venueDisplayName("predictfun")).toBe("predict.fun");
    expect(venueDisplayName("sxbet")).toBe("SX.bet");
  });
});
