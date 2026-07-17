import { describe, expect, it } from "vitest";
import { normalizeTeamName, teamMatchesTitle, teamsMatch } from "./teamNormalization";

describe("NBA Summer League team normalization", () => {
  it("matches Kalshi's Los Angeles disambiguators to the correct NBA team", () => {
    expect(
      teamMatchesTitle(
        "Los Angeles Clippers",
        "Clippers",
        "LAC",
        "Minnesota vs Los Angeles C",
        "nba_summer"
      )
    ).toBe(true);
    expect(
      teamMatchesTitle(
        "Los Angeles Lakers",
        "Lakers",
        "LAL",
        "Minnesota vs Los Angeles C",
        "nba_summer"
      )
    ).toBe(false);
  });

  it("matches SX.bet punctuation and abbreviations", () => {
    expect(teamsMatch("L.A. Clippers", "Los Angeles Clippers", "nba_summer")).toBe(true);
    expect(teamsMatch("NY Knicks", "New York Knicks", "nba_summer")).toBe(true);
  });

  it("keeps basketball city aliases scoped away from MLB", () => {
    expect(normalizeTeamName("Boston", "nba_summer")).toBe("boston celtics");
    expect(normalizeTeamName("Boston", "mlb")).toBe("boston red sox");
  });
});
