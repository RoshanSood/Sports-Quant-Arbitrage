import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudbetMoneylineByGame, fetchCloudbetSpreadByGame, fetchCloudbetTotalsByGame } from "./cloudbet";
import { SPORTS, type ArbGame, type CloudbetSportCfg } from "./arbitrage/sports";
import { normalizeTeamName, teamsMatch } from "./teamNormalization";

const game: ArbGame = {
  id: "401853967",
  date: "2026-08-14",
  awayTeam: { name: "Kansas City Current", shortName: "Kansas City", abbreviation: "KC" },
  homeTeam: { name: "Gotham FC", shortName: "Gotham", abbreviation: "GFC" },
};

const cfg: CloudbetSportCfg = {
  competition: "soccer-usa-national-womens-soccer-league",
  moneyline: "soccer.match_odds",
  total: "soccer.total_goals",
  spread: "soccer.asian_handicap",
  spreadLine: 1.5,
  threeWay: true,
};

function selection(outcome: string, params: string, price: number, marketUrl: string) {
  return { outcome, params, price, marketUrl, maxStake: 50, status: "SELECTION_ENABLED", side: "BACK" };
}

function cloudbetEvent(marketKey: string, selections: unknown[]) {
  return {
    events: [{
      id: 35783782,
      home: { name: "Gotham FC (w)" },
      away: { name: "Kansas City NWSL (w)" },
      status: "TRADING",
      cutoffTime: "2026-08-15T00:00:00Z",
      markets: { [marketKey]: { liability: 100, submarkets: { "period=ft": { selections } } } },
    }],
  };
}

describe("NWSL scanner configuration", () => {
  it("wires the ESPN, Kalshi, and Cloudbet league identifiers", () => {
    const nwsl = SPORTS.find((sport) => sport.league === "nwsl");
    expect(nwsl).toMatchObject({
      sport: "soccer",
      markets: { totals: true, spread: true, moneyline: true },
      kalshi: { game: "KXNWSLGAME", total: "KXNWSLTOTAL", spread: "KXNWSLSPREAD", threeWay: true },
      cloudbet: { competition: "soccer-usa-national-womens-soccer-league", threeWay: true },
    });
  });

  it("normalizes current ESPN, Kalshi, and Cloudbet team-name variants", () => {
    expect(normalizeTeamName("OL Reign (w)")).toBe("seattle reign fc");
    expect(normalizeTeamName("Chicago Red Stars (w)")).toBe("chicago stars fc");
    expect(normalizeTeamName("Kansas City NWSL (w)")).toBe("kansas city current");
    expect(normalizeTeamName("Boston Legacy Women")).toBe("boston legacy fc");
    expect(teamsMatch("Gotham FC (w)", "Gotham FC")).toBe(true);
  });
});

describe("Cloudbet NWSL normalization", () => {
  beforeEach(() => vi.stubEnv("CLOUDBET_API_KEY", "test-key"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("requires and emits all three 1X2 outcomes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => cloudbetEvent("soccer.match_odds", [
        selection("home", "", 2.1, "soccer.match_odds/home"),
        selection("draw", "", 3.4, "soccer.match_odds/draw"),
        selection("away", "", 3.2, "soccer.match_odds/away"),
      ]),
    }));
    const result = await fetchCloudbetMoneylineByGame([game], cfg);
    expect(result.get(game.id)).toMatchObject({
      marketId: "35783782",
      homeTokenId: "soccer.match_odds/home",
      awayTokenId: "soccer.match_odds/away",
      drawTokenId: "soccer.match_odds/draw",
      sourceStartTime: "2026-08-14",
    });
  });

  it("emits only half-goal totals so push/quarter-line contracts cannot be mismatched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => cloudbetEvent("soccer.total_goals", [
        selection("over", "total=2.5", 1.9, "soccer.total_goals/over?total=2.5"),
        selection("under", "total=2.5", 2.0, "soccer.total_goals/under?total=2.5"),
        selection("over", "total=2.25", 1.8, "soccer.total_goals/over?total=2.25"),
        selection("under", "total=2.25", 2.1, "soccer.total_goals/under?total=2.25"),
      ]),
    }));
    const result = await fetchCloudbetTotalsByGame([game], cfg);
    expect(result.get(game.id)?.map((line) => line.line)).toEqual([2.5]);
  });

  it("selects the configured 1.5 goal handicap and preserves native market URLs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => cloudbetEvent("soccer.asian_handicap", [
        selection("home", "handicap=-0.5", 1.7, "soccer.asian_handicap/home?handicap=-0.5"),
        selection("away", "handicap=-0.5", 2.2, "soccer.asian_handicap/away?handicap=-0.5"),
        selection("home", "handicap=-1.5", 2.4, "soccer.asian_handicap/home?handicap=-1.5"),
        selection("away", "handicap=-1.5", 1.5, "soccer.asian_handicap/away?handicap=-1.5"),
      ]),
    }));
    const result = await fetchCloudbetSpreadByGame([game], cfg);
    expect(result.get(game.id)).toMatchObject({
      homeSignedLine: -1.5,
      homeTokenId: "soccer.asian_handicap/home?handicap=-1.5",
      awayTokenId: "soccer.asian_handicap/away?handicap=-1.5",
    });
  });
});
