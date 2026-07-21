import { describe, it, expect } from "vitest";
import { matchMoneyline, matchTotals } from "./matching";
import { detectArbs } from "./arbEngine";
import { DEFAULT_AGENT } from "./seed";
import type { MarketType, NormalizedMarket, Outcome, Sport } from "@/types/arbitrage";

function nm(
  venue: string,
  outcome: Outcome,
  priceCents: number,
  opts: { line?: number; liquidityUsd?: number; marketType?: MarketType } = {}
): NormalizedMarket {
  const { line = 6.5, liquidityUsd = 100, marketType = "total" } = opts;
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
    lastUpdated: new Date().toISOString(),
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
});

// Moneyline market helper (2-way home/away, or soccer 3-way home/draw/away).
function ml(
  venue: string,
  outcome: Outcome,
  priceCents: number,
  sport: Sport = "soccer",
  teams: [string, string] = ["Inter Miami", "LA Galaxy"]
): NormalizedMarket {
  const league = sport === "tennis" ? "wta" : sport === "soccer" ? "mls" : "mlb";
  return {
    venueId: venue,
    marketId: `${venue}:900:moneyline:0:${outcome}`,
    sport,
    league,
    startTime: "2026-07-10",
    teams,
    marketType: "moneyline",
    line: null,
    outcome,
    priceCents,
    decimalOdds: 100 / priceCents,
    impliedProbability: priceCents / 100,
    depth: 10,
    liquidityUsd: 100,
    live: true,
    status: "open",
    lastUpdated: new Date().toISOString(),
  };
}

function detectML(markets: NormalizedMarket[]) {
  const { matched } = matchMoneyline(markets);
  return detectArbs(matched, DEFAULT_AGENT, MIN_LIQ);
}

describe("arbEngine — 3-way soccer (1X2)", () => {
  it("emits a 3-leg arb when home+draw+away across 3 venues cost < 100", () => {
    const { opportunities } = detectML([
      ml("cloudbet", "home", 40),
      ml("polymarket", "draw", 27),
      ml("sxbet", "away", 28),
    ]);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].legs).toHaveLength(3);
    expect(opportunities[0].totalCostCents).toBe(95);
    expect(new Set(opportunities[0].legs.map((l) => l.venueId)).size).toBe(3);
  });

  it("does NOT treat a soccer home/away pair as an arb (the draw would lose both legs)", () => {
    const { opportunities } = detectML([
      ml("cloudbet", "home", 45),
      ml("polymarket", "away", 48), // sums < 100 but there is no draw leg → not guaranteed
    ]);
    expect(opportunities).toHaveLength(0);
  });

  it("requires the 3 outcomes on 3 DISTINCT venues", () => {
    const { opportunities } = detectML([
      ml("cloudbet", "home", 40),
      ml("cloudbet", "draw", 27), // draw only on the same venue as home
      ml("sxbet", "away", 28),
    ]);
    expect(opportunities).toHaveLength(0);
  });
});

describe("arbEngine — 2-way tennis moneyline", () => {
  it("emits a 2-leg arb for a tennis match (no draw outcome)", () => {
    const { opportunities } = detectML([
      ml("cloudbet", "home", 47, "tennis", ["Swiatek", "Gauff"]),
      ml("polymarket", "away", 46, "tennis", ["Swiatek", "Gauff"]),
    ]);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].legs).toHaveLength(2);
    expect(opportunities[0].totalCostCents).toBe(93);
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
