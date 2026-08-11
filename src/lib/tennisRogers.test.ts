import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPORTS, type ArbGame } from "./arbitrage/sports";
import { fetchCloudbetMoneylineByGame } from "./cloudbet";
import { fetchSxBetMoneylineByGame } from "./sxbet";

const atpGame: ArbGame = {
  id: "181722",
  date: "2026-08-10",
  awayTeam: { name: "Arthur Fils", shortName: "A. Fils", abbreviation: "ART" },
  homeTeam: { name: "Rafael Jodar", shortName: "R. Jodar", abbreviation: "RAF" },
};

describe("Rogers tournament discovery", () => {
  beforeEach(() => vi.stubEnv("CLOUDBET_API_KEY", "test-key"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("finds Cloudbet ATP tournaments whose keys are country-namespaced", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/sports/tennis")) {
        return new Response(JSON.stringify({ categories: [{ competitions: [{
          key: "tennis-canada-tc2c4-atp-masters-1000-toronto-montreal-rogers-cup",
          name: "ATP Masters 1000 Toronto/Montreal (Rogers Cup)",
          eventCount: 1,
        }] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [{
        id: 35786005,
        home: { name: "Rafael Jodar" },
        away: { name: "Arthur Fils" },
        status: "TRADING",
        cutoffTime: "2026-08-10T22:00:00Z",
        markets: { "tennis.winner": { liability: 50, submarkets: { main: { selections: [
          { outcome: "home", price: 2.1, status: "SELECTION_ENABLED", marketUrl: "tennis.winner/home" },
          { outcome: "away", price: 1.8, status: "SELECTION_ENABLED", marketUrl: "tennis.winner/away" },
        ] } } } },
      }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = SPORTS.find((entry) => entry.league === "atp")!;
    const quote = (await fetchCloudbetMoneylineByGame([atpGame], cfg.cloudbet!)).get(atpGame.id);
    expect(quote).toMatchObject({ marketId: "35786005", homeTokenId: "tennis.winner/home", awayTokenId: "tennis.winner/away" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("tennis-canada-tc2c4-atp-masters-1000-toronto-montreal-rogers-cup"),
      expect.anything()
    );
  });

  it("coalesces concurrent SX tournament catalog reads", async () => {
    let leagueRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/leagues")) {
        leagueRequests += 1;
        return new Response(JSON.stringify({ data: [
          { leagueId: 100, label: "ATP Toronto", sportId: 6, active: true },
          { leagueId: 101, label: "WTA Montreal", sportId: 6, active: true },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { markets: [] } }), { status: 200 });
    }));

    await Promise.all([
      fetchSxBetMoneylineByGame([atpGame], { sportId: 6, leagueMatch: /atp/i }),
      fetchSxBetMoneylineByGame([atpGame], { sportId: 6, leagueMatch: /wta/i }),
    ]);
    expect(leagueRequests).toBe(1);
  });
});
