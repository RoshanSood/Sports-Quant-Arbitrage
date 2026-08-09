import { describe, it, expect, vi, afterEach } from "vitest";
import { espnTennisGamesFetcher } from "./espnSports";

// Fixture shape captured live 2026-08-09 from ESPN's tennis/wta scoreboard for the National
// Bank Open — a co-hosted ATP+WTA stop. Confirms the real bug: both /atp and /wta scoreboard
// paths return this SAME event with all four groupings (men's/women's singles/doubles), so
// filtering must happen on grouping.slug, not on which path was queried.
function coHostedEvent() {
  const notCompletedStatus = { type: { completed: false, state: "pre" } };
  const match = (id: string, awayName: string, homeName: string) => ({
    id,
    status: notCompletedStatus,
    competitors: [
      { homeAway: "away", athlete: { displayName: awayName } },
      { homeAway: "home", athlete: { displayName: homeName } },
    ],
  });
  return {
    id: "421-2026",
    groupings: [
      { grouping: { id: "1", slug: "mens-singles" }, competitions: [match("m1", "Nicolas Mejia", "Marco Trungelliti")] },
      { grouping: { id: "2", slug: "womens-singles" }, competitions: [match("w1", "Marina Bassols Ribera", "Victoria Jimenez Kasintseva")] },
      { grouping: { id: "3", slug: "mens-doubles" }, competitions: [match("md1", "Andre Goransson/Casper Ruud", "Lucas Miedler/Marc Polmans")] },
      { grouping: { id: "4", slug: "womens-doubles" }, competitions: [match("wd1", "Storm Hunter/Desirae Krawczyk", "Katarzyna Piter/Janice Tjen")] },
    ],
  };
}

describe("espnTennisGamesFetcher — gender/singles filtering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchReturning(events: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events }) })
    );
  }

  it("WTA fetcher returns ONLY women's-singles matches from a co-hosted event", async () => {
    mockFetchReturning([coHostedEvent()]);
    const games = await espnTennisGamesFetcher("tennis/wta")("20260809");
    expect(games).toHaveLength(1);
    expect(games[0].awayTeam.name).toBe("Marina Bassols Ribera");
    expect(games[0].homeTeam.name).toBe("Victoria Jimenez Kasintseva");
  });

  it("ATP fetcher returns ONLY men's-singles matches from the SAME co-hosted event", async () => {
    mockFetchReturning([coHostedEvent()]);
    const games = await espnTennisGamesFetcher("tennis/atp")("20260809");
    expect(games).toHaveLength(1);
    expect(games[0].awayTeam.name).toBe("Nicolas Mejia");
    expect(games[0].homeTeam.name).toBe("Marco Trungelliti");
  });

  it("never returns doubles matches for either tour", async () => {
    mockFetchReturning([coHostedEvent()]);
    const wta = await espnTennisGamesFetcher("tennis/wta")("20260809");
    const atp = await espnTennisGamesFetcher("tennis/atp")("20260809");
    for (const g of [...wta, ...atp]) {
      expect(g.awayTeam.name).not.toContain("/");
      expect(g.homeTeam.name).not.toContain("/");
    }
  });

  it("returns [] for an unrecognized tour path rather than guessing", async () => {
    mockFetchReturning([coHostedEvent()]);
    const games = await espnTennisGamesFetcher("tennis/challenger")("20260809");
    expect(games).toEqual([]);
  });
});
