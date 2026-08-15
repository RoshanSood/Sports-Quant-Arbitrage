import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPolymarketMoneylineByGame } from "./polymarket";

describe("Polymarket NFL outcome-token mapping", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the Dolphins token to away and Commanders token to home", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "event-2858842",
      title: "Miami Dolphins - Washington Commanders",
      slug: "nfl-mia-was-2026-08-14",
      eventDate: "2026-08-14T23:00:00Z",
      markets: [{
        id: "2858842",
        question: "Dolphins vs. Commanders",
        outcomes: JSON.stringify(["Dolphins", "Commanders"]),
        outcomePrices: JSON.stringify(["0.64", "0.36"]),
        clobTokenIds: JSON.stringify(["dolphins-token", "commanders-token"]),
        bestBid: 0.35,
        bestAsk: 0.65,
        liquidityNum: 100_000,
      }],
    }]), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await fetchPolymarketMoneylineByGame([{
      id: "401873277",
      date: "2026-08-14",
      awayTeam: { name: "Miami Dolphins", shortName: "Dolphins", abbreviation: "MIA" },
      homeTeam: { name: "Washington Commanders", shortName: "Commanders", abbreviation: "WAS" },
    }], "nfl");

    expect(result.get("401873277")).toMatchObject({
      awayTokenId: "dolphins-token",
      homeTokenId: "commanders-token",
      awayCents: 65,
      homeCents: 65,
      marketId: "2858842",
    });
  });

  it("drops a two-way market whose team labels cannot be proven", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "event-ambiguous",
      title: "Miami Dolphins - Washington Commanders",
      slug: "nfl-mia-was-2026-08-14",
      eventDate: "2026-08-14T23:00:00Z",
      markets: [{
        id: "ambiguous",
        question: "Dolphins vs. Commanders",
        outcomes: JSON.stringify(["Yes", "No"]),
        outcomePrices: JSON.stringify(["0.50", "0.50"]),
        clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
        bestBid: 0.49,
        bestAsk: 0.51,
        liquidityNum: 100_000,
      }],
    }]), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await fetchPolymarketMoneylineByGame([{
      id: "401873277",
      date: "2026-08-14",
      awayTeam: { name: "Miami Dolphins", shortName: "Dolphins", abbreviation: "MIA" },
      homeTeam: { name: "Washington Commanders", shortName: "Commanders", abbreviation: "WAS" },
    }], "nfl");

    expect(result.has("401873277")).toBe(false);
  });
});
