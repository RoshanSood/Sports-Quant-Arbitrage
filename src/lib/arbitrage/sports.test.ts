import { describe, expect, it } from "vitest";
import { isEligibleArbGame, SPORTS, type ArbGame } from "./sports";

function game(status: string): ArbGame {
  return {
    id: "game-1",
    date: "2026-07-17",
    status,
    awayTeam: { name: "Kings", shortName: "Kings", abbreviation: "SAC" },
    homeTeam: { name: "Hornets", shortName: "Hornets", abbreviation: "CHA" },
  };
}

describe("NBA Summer League sport configuration", () => {
  it("uses the live Kalshi series and SX.bet league", () => {
    const summer = SPORTS.find((sport) => sport.league === "nba_summer");
    expect(summer).toMatchObject({
      sport: "basketball",
      kalshi: {
        game: "KXNBASUMMERGAME",
        total: "KXNBASUMMERTOTAL",
        spread: "KXNBASUMMERSPREAD",
      },
      sxLeagueId: 1589,
      spreadFixedLine: undefined,
      polyTag: undefined,
    });
  });

  it("does not ingest completed or postponed games", () => {
    expect(isEligibleArbGame(game("Scheduled"))).toBe(true);
    expect(isEligibleArbGame(game("Final"))).toBe(false);
    expect(isEligibleArbGame(game("Postponed"))).toBe(false);
  });
});
