import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArbGame } from "./arbitrage/sports";
import { fetchPolymarketArbMarkets } from "./polymarketArbitrage";

const game: ArbGame = {
  id: "game-1",
  date: "2026-07-14",
  startTimeIso: "2026-07-15T00:05:00.000Z",
  status: "Scheduled",
  awayTeam: { name: "New York Yankees", shortName: "Yankees", abbreviation: "NYY" },
  homeTeam: { name: "Boston Red Sox", shortName: "Red Sox", abbreviation: "BOS" },
};

function market(id: string, question: string, outcomes: string[], tokens: string[]) {
  return { id, question, outcomes: JSON.stringify(outcomes), clobTokenIds: JSON.stringify(tokens) };
}

afterEach(() => vi.restoreAllMocks());

describe("Polymarket arbitrage orderbooks", () => {
  it("fetches Gamma once and carries outcome token IDs with real top-book depth", async () => {
    const gamma = [
      {
        id: "wrong-time",
        title: "New York Yankees vs. Boston Red Sox",
        startTime: "2026-07-15T06:05:00.000Z",
        markets: [
          market("wrong-ml", "New York Yankees vs. Boston Red Sox", ["New York Yankees", "Boston Red Sox"], ["wrong-away", "wrong-home"]),
        ],
      },
      {
        id: "event-1",
        title: "New York Yankees vs. Boston Red Sox",
        startDate: "2026-07-01T00:00:00.000Z",
        startTime: "2026-07-15T00:05:00.000Z",
        markets: [
          market("generic", "Will the game go to overtime?", ["Yes", "No"], ["yes", "no"]),
          market("f5", "Yankees vs Red Sox 1st 5 Innings O/U 4.5", ["Over", "Under"], ["f5-over", "f5-under"]),
          market("team-total", "Yankees O/U 4.5", ["Over", "Under"], ["team-over", "team-under"]),
          { ...market("ml", "New York Yankees vs. Boston Red Sox", ["New York Yankees", "Boston Red Sox"], ["away", "home"]), feesEnabled: true, feeSchedule: { rate: 0.05 } },
          market("sp", "Spread: New York Yankees (-1.5)", ["New York Yankees", "Boston Red Sox"], ["away-sp", "home-sp"]),
          { ...market("tot", "Yankees vs Red Sox O/U 8.5", ["Over", "Under"], ["over", "under"]), feesEnabled: true, feeSchedule: { rate: 0.05 } },
        ],
      },
    ];
    const books = [
      { asset_id: "away", asks: [{ price: "0.47", size: "20" }] },
      { asset_id: "home", asks: [{ price: "0.55", size: "30" }] },
      { asset_id: "away-sp", asks: [{ price: "0.49", size: "10" }] },
      { asset_id: "home-sp", asks: [{ price: "0.53", size: "10" }] },
      { asset_id: "over", asks: [{ price: "0.48", size: "25" }] },
      { asset_id: "under", asks: [{ price: "0.51", size: "40" }] },
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(gamma), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(books), { status: 200 }));

    const result = await fetchPolymarketArbMarkets([game], "mlb");
    expect(fetch).toHaveBeenCalledTimes(2);
    const gammaUrl = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(gammaUrl).toContain("limit=500");
    expect(gammaUrl).toContain("start_time_min=");
    expect(gammaUrl).toContain("start_time_max=");
    expect(result.moneyline.get(game.id)?.marketId).toBe("ml");
    expect(result.moneyline.get(game.id)?.awayNativeMarketId).toBe("away");
    expect(result.moneyline.get(game.id)?.feeRate).toBe(0.05);
    expect(result.moneyline.get(game.id)?.homeLiquidityUsd).toBe(16.5);
    expect(result.spread.get(game.id)?.homeSignedLine).toBe(1.5);
    expect(result.totals.get(game.id)?.[0]).toMatchObject({
      line: 8.5,
      overCents: 48,
      underCents: 51,
      overNativeMarketId: "over",
      underNativeMarketId: "under",
      overLiquidityUsd: 12,
      feeRate: 0.05,
    });
    expect(result.totals.get(game.id)).toHaveLength(1);
  });
});
