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
    const gamma = [{
      id: "event-1",
      title: "New York Yankees vs. Boston Red Sox",
      startDate: "2026-07-15T00:05:00.000Z",
      markets: [
        market("ml", "New York Yankees vs. Boston Red Sox", ["New York Yankees", "Boston Red Sox"], ["away", "home"]),
        market("sp", "Spread: New York Yankees (-1.5)", ["New York Yankees", "Boston Red Sox"], ["away-sp", "home-sp"]),
        market("tot", "Yankees vs Red Sox O/U 8.5", ["Over", "Under"], ["over", "under"]),
      ],
    }];
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
    expect(result.moneyline.get(game.id)?.awayNativeMarketId).toBe("away");
    expect(result.moneyline.get(game.id)?.homeLiquidityUsd).toBe(16.5);
    expect(result.spread.get(game.id)?.homeSignedLine).toBe(1.5);
    expect(result.totals.get(game.id)?.[0]).toMatchObject({
      line: 8.5,
      overCents: 48,
      underCents: 51,
      overNativeMarketId: "over",
      underNativeMarketId: "under",
      overLiquidityUsd: 12,
    });
  });
});
