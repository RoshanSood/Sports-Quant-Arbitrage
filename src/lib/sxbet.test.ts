import { describe, expect, it } from "vitest";
import { marketMatchesGame, signedSpreadLine, type SxMarket } from "./sxbet";
import type { ArbGame } from "./arbitrage/sports";

const GAME: ArbGame = {
  id: "nba-summer-1",
  date: "2026-07-17",
  startTimeIso: "2026-07-17T22:00:00Z",
  awayTeam: { name: "Minnesota Timberwolves", shortName: "Timberwolves", abbreviation: "MIN" },
  homeTeam: { name: "Los Angeles Clippers", shortName: "Clippers", abbreviation: "LAC" },
};

function sxMarket(gameTime: number): SxMarket {
  return {
    marketHash: "0xsummer",
    type: 226,
    line: null,
    outcomeOneName: "Minnesota Timberwolves",
    outcomeTwoName: "L.A. Clippers",
    teamOneName: "Minnesota Timberwolves",
    teamTwoName: "L.A. Clippers",
    gameTime,
  };
}

describe("SX.bet Summer League matching", () => {
  it("matches the same teams at the scheduled start", () => {
    expect(
      marketMatchesGame(sxMarket(Date.parse("2026-07-17T22:10:00Z") / 1000), GAME, "nba_summer")
    ).toBe(true);
  });

  it("does not attach a same-team market from a different game time", () => {
    expect(
      marketMatchesGame(sxMarket(Date.parse("2026-07-18T22:00:00Z") / 1000), GAME, "nba_summer")
    ).toBe(false);
  });

  it("preserves variable basketball spread lines", () => {
    expect(signedSpreadLine("Clippers +3.5", -1.5)).toBe(3.5);
    expect(signedSpreadLine("Timberwolves -3.5", 1.5)).toBe(-3.5);
  });
});
