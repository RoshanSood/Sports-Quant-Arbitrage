import { describe, it, expect } from "vitest";
import { matchTotals, matchMoneyline, matchMarkets } from "./matching";
import type { MarketType, NormalizedMarket, Outcome } from "@/types/arbitrage";

function nm(
  venue: string,
  marketType: MarketType,
  outcome: Outcome,
  priceCents: number,
  opts: { line?: number | null; teams?: [string, string]; liquidityUsd?: number; startTime?: string } = {}
): NormalizedMarket {
  const { line = null, teams = ["Reds", "Phillies"], liquidityUsd = 100, startTime = "2026-07-10T17:05:00.000Z" } = opts;
  return {
    venueId: venue,
    marketId: `${venue}:401:${marketType}:${line ?? 0}:${outcome}`,
    sport: "baseball",
    league: "mlb",
    startTime,
    teams,
    marketType,
    line,
    outcome,
    priceCents,
    decimalOdds: 100 / priceCents,
    impliedProbability: priceCents / 100,
    depth: 10,
    liquidityUsd,
    live: true,
    status: "open",
    lastUpdated: new Date().toISOString(),
  };
}

describe("matching — totals", () => {
  it("matches the same line across venues", () => {
    const { matched, stats } = matchTotals([
      nm("kalshi", "total", "over", 51, { line: 6.5 }),
      nm("kalshi", "total", "under", 49, { line: 6.5 }),
      nm("polymarket", "total", "over", 41, { line: 6.5 }),
      nm("polymarket", "total", "under", 59, { line: 6.5 }),
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0].line).toBe(6.5);
    expect(matched[0].venues.sort()).toEqual(["kalshi", "polymarket"]);
    expect(stats.matched).toBe(1);
  });

  it("rejects a line mismatch (6.5 vs 7.5) instead of matching (manual §5)", () => {
    const { matched, rejects } = matchTotals([
      nm("kalshi", "total", "over", 51, { line: 6.5 }),
      nm("kalshi", "total", "under", 49, { line: 6.5 }),
      nm("polymarket", "total", "over", 41, { line: 7.5 }),
      nm("polymarket", "total", "under", 59, { line: 7.5 }),
    ]);
    expect(matched).toHaveLength(0);
    expect(rejects.some((r) => r.reason === "line_mismatch")).toBe(true);
  });

  it("ignores a single-venue event (nothing to compare)", () => {
    const { matched } = matchTotals([
      nm("kalshi", "total", "over", 51, { line: 6.5 }),
      nm("kalshi", "total", "under", 49, { line: 6.5 }),
    ]);
    expect(matched).toHaveLength(0);
  });

  it("keeps same-team doubleheaders in separate event buckets", () => {
    const early = "2026-07-10T17:05:00.000Z";
    const late = "2026-07-10T23:05:00.000Z";
    const { matched } = matchTotals([
      nm("kalshi", "total", "over", 51, { line: 6.5, startTime: early }),
      nm("polymarket", "total", "under", 48, { line: 6.5, startTime: early }),
      nm("kalshi", "total", "over", 50, { line: 8.5, startTime: late }),
      nm("polymarket", "total", "under", 49, { line: 8.5, startTime: late }),
    ]);
    expect(matched).toHaveLength(2);
    expect(new Set(matched.map((event) => event.eventKey)).size).toBe(2);
  });
});

describe("matching — moneyline + combiner", () => {
  it("matches home/away across venues with team labels", () => {
    const { matched } = matchMoneyline([
      nm("kalshi", "moneyline", "home", 55),
      nm("kalshi", "moneyline", "away", 47),
      nm("polymarket", "moneyline", "home", 54),
      nm("polymarket", "moneyline", "away", 48),
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0].marketType).toBe("moneyline");
    const homeLeg = matched[0].legs.find((l) => l.outcome === "home" && l.venueId === "kalshi");
    expect(homeLeg?.label).toBe("Phillies"); // teams = [away Reds, home Phillies]
  });

  it("matchMarkets merges totals + moneyline", () => {
    const { matched } = matchMarkets([
      nm("kalshi", "total", "over", 51, { line: 6.5 }),
      nm("kalshi", "total", "under", 49, { line: 6.5 }),
      nm("polymarket", "total", "over", 41, { line: 6.5 }),
      nm("polymarket", "total", "under", 59, { line: 6.5 }),
      nm("kalshi", "moneyline", "home", 55),
      nm("kalshi", "moneyline", "away", 47),
      nm("polymarket", "moneyline", "home", 54),
      nm("polymarket", "moneyline", "away", 48),
    ]);
    const types = matched.map((m) => m.marketType).sort();
    expect(types).toEqual(["moneyline", "total"]);
  });
});
