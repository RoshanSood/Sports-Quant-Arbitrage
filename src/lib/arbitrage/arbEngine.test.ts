import { describe, it, expect } from "vitest";
import { matchTotals } from "./matching";
import { detectArbs } from "./arbEngine";
import { DEFAULT_AGENT } from "./seed";
import type { MarketType, NormalizedMarket, Outcome } from "@/types/arbitrage";

function nm(
  venue: string,
  outcome: Outcome,
  priceCents: number,
  opts: { line?: number; liquidityUsd?: number; marketType?: MarketType; lastUpdated?: string } = {}
): NormalizedMarket {
  const { line = 6.5, liquidityUsd = 100, marketType = "total", lastUpdated = new Date().toISOString() } = opts;
  return {
    venueId: venue,
    marketId: `${venue}:401:${marketType}:${line}:${outcome}`,
    sport: "baseball",
    league: "mlb",
    startTime: "2026-07-10",
    teams: ["Reds", "Phillies"],
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
    lastUpdated,
  };
}

const MIN_LIQ = 20;

function detect(markets: NormalizedMarket[]) {
  const { matched } = matchTotals(markets);
  return detectArbs(matched, DEFAULT_AGENT, MIN_LIQ);
}

describe("arbEngine — gates (manual §8/§13)", () => {
  it("emits an opportunity for a valid cross-venue arb", () => {
    const { opportunities } = detect([
      nm("kalshi", "over", 52),
      nm("kalshi", "under", 48),
      nm("polymarket", "over", 45),
      nm("polymarket", "under", 50),
    ]);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].marketType).toBe("total");
    expect(opportunities[0].totalCostCents).toBe(93); // cheapest over 45 + under 48
    expect(opportunities[0].netEdge).toBeGreaterThan(DEFAULT_AGENT.minEdge);
    expect(opportunities[0].legs[0].size).toBe(opportunities[0].legs[1].size);
    expect(opportunities[0].quoteFreshness).toBeLessThan(1000);
  });

  it("rejects snapshots older than the agent freshness limit", () => {
    const stale = new Date(Date.now() - DEFAULT_AGENT.staleQuoteMs - 1000).toISOString();
    const { opportunities, rejects } = detect([
      nm("kalshi", "over", 52, { lastUpdated: stale }),
      nm("kalshi", "under", 48, { lastUpdated: stale }),
      nm("polymarket", "over", 45, { lastUpdated: stale }),
      nm("polymarket", "under", 50, { lastUpdated: stale }),
    ]);
    expect(opportunities).toHaveLength(0);
    expect(rejects.some((reject) => reject.reason === "stale_quote")).toBe(true);
  });

  it("rejects stale quotes when venues diverge on over price", () => {
    const { opportunities, rejects } = detect([
      nm("kalshi", "over", 52),
      nm("kalshi", "under", 48),
      nm("polymarket", "over", 30), // 22c divergence
      nm("polymarket", "under", 50),
    ]);
    expect(opportunities).toHaveLength(0);
    expect(rejects.some((r) => r.reason === "stale_quote")).toBe(true);
  });

  it("rejects edges above the max as suspicious", () => {
    const { opportunities, rejects } = detect([
      nm("kalshi", "over", 40),
      nm("kalshi", "under", 38),
      nm("polymarket", "over", 38),
      nm("polymarket", "under", 40),
    ]);
    expect(opportunities).toHaveLength(0);
    expect(rejects.some((r) => r.reason === "edge_above_max")).toBe(true);
  });

  it("rejects when executable liquidity is below the floor", () => {
    const { opportunities, rejects } = detect([
      nm("kalshi", "over", 52, { liquidityUsd: 5 }),
      nm("kalshi", "under", 48, { liquidityUsd: 5 }),
      nm("polymarket", "over", 45, { liquidityUsd: 5 }),
      nm("polymarket", "under", 50, { liquidityUsd: 5 }),
    ]);
    expect(opportunities).toHaveLength(0);
    expect(rejects.some((r) => r.reason === "insufficient_depth")).toBe(true);
  });

  it("selects the best fee-adjusted pair across three venues", () => {
    const { opportunities } = detect([
      nm("kalshi", "over", 40),
      nm("kalshi", "under", 60),
      nm("polymarket", "over", 40.4),
      nm("polymarket", "under", 59.6),
      nm("sxbet", "over", 43),
      nm("sxbet", "under", 57),
    ]);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].legs.map((leg) => leg.venueId).sort()).toEqual(["polymarket", "sxbet"]);
  });
});

describe("arbEngine — main-line selection", () => {
  it("picks the line where Kalshi's over is closest to 50/50", () => {
    const { watch } = detect([
      // tail line 2.5 — Kalshi over near-certain (stale-prone)
      nm("kalshi", "over", 95, { line: 2.5 }),
      nm("kalshi", "under", 6, { line: 2.5 }),
      nm("polymarket", "over", 80, { line: 2.5 }),
      nm("polymarket", "under", 20, { line: 2.5 }),
      // main line 8.5 — balanced
      nm("kalshi", "over", 51, { line: 8.5 }),
      nm("kalshi", "under", 50, { line: 8.5 }),
      nm("polymarket", "over", 50, { line: 8.5 }),
      nm("polymarket", "under", 51, { line: 8.5 }),
    ]);
    // one watch entry per game — the main line 8.5, not the tail 2.5
    expect(watch).toHaveLength(1);
    expect(watch[0].line).toBe(8.5);
  });
});
