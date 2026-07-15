import { describe, it, expect } from "vitest";
import { computeRealized } from "./settlement";
import type { ArbLeg, Trade, TradeStatus } from "@/types/arbitrage";

function mkLeg(marketId: string, outcome: ArbLeg["outcome"], priceCents: number, size: number): ArbLeg {
  return {
    venueId: marketId.split(":")[0],
    marketId,
    outcome,
    priceCents,
    decimalOdds: 100 / priceCents,
    impliedProbability: priceCents / 100,
    size,
    feeCents: 0,
  };
}

function mkTrade(legs: ArbLeg[], status: TradeStatus, opts: { expectedProfit?: number; nakedLegIndex?: number } = {}): Trade {
  return {
    id: "t",
    mode: "paper",
    opportunityId: "o",
    agentId: "kalshi-mlb",
    matchup: "Reds v Phillies",
    legs,
    orderIds: [],
    fillStatus: status === "naked" ? "partial" : "filled",
    totalCost: 40,
    expectedProfit: opts.expectedProfit ?? 4.4,
    realizedPnl: null,
    netEdge: 0.05,
    clvDrift: null,
    status,
    openedAt: "2026-07-10T00:00:00.000Z",
    closedAt: null,
    date: "20260710",
    nakedLegIndex: opts.nakedLegIndex,
  };
}

describe("settlement — hedged arb realizes expected profit", () => {
  it("pays the guaranteed profit regardless of score", () => {
    const t = mkTrade(
      [mkLeg("kalshi:401:total:6.5:over", "over", 45, 40), mkLeg("polymarket:401:total:6.5:under", "under", 50, 40)],
      "open",
      { expectedProfit: 4.4 }
    );
    expect(computeRealized(t, { away: 5, home: 5, total: 10 })).toBe(2);
  });
});

describe("settlement — naked totals graded by result", () => {
  it("OVER 6.5 wins when total is 10 → size − cost", () => {
    const t = mkTrade([mkLeg("kalshi:401:total:6.5:over", "over", 45, 40)], "naked", { nakedLegIndex: 0 });
    expect(computeRealized(t, { away: 5, home: 5, total: 10 })).toBe(40 - 18); // cost 40*0.45
  });
  it("UNDER 6.5 loses when total is 10 → −cost", () => {
    const t = mkTrade([mkLeg("kalshi:401:total:6.5:under", "under", 50, 40)], "naked", { nakedLegIndex: 0 });
    expect(computeRealized(t, { away: 5, home: 5, total: 10 })).toBe(-20); // cost 40*0.50
  });
});

describe("settlement — naked moneyline graded by winner", () => {
  it("AWAY wins when away score is higher", () => {
    const t = mkTrade([mkLeg("kalshi:401:moneyline:0:away", "away", 45, 40)], "naked", { nakedLegIndex: 0 });
    expect(computeRealized(t, { away: 9, home: 7, total: 16 })).toBe(40 - 18);
  });
});

describe("settlement — naked spread graded by margin + signed line", () => {
  it("home −1.5 covers when home wins by 2 (margin + line > 0)", () => {
    const t = mkTrade([mkLeg("kalshi:401:spread:-1.5:home", "home", 50, 40)], "naked", { nakedLegIndex: 0 });
    // home 9 - away 7 = +2 margin; 2 + (-1.5) = 0.5 > 0 → home covers → win
    expect(computeRealized(t, { away: 7, home: 9, total: 16 })).toBe(40 - 20);
  });
  it("home −1.5 does NOT cover when home wins by 1 → −cost", () => {
    const t = mkTrade([mkLeg("kalshi:401:spread:-1.5:home", "home", 50, 40)], "naked", { nakedLegIndex: 0 });
    // margin +1; 1 + (-1.5) = -0.5 < 0 → away covers → home leg loses
    expect(computeRealized(t, { away: 7, home: 8, total: 15 })).toBe(-20);
  });
  it("refunds both sides on an integer-line push", () => {
    const t = mkTrade([
      mkLeg("kalshi:401:spread:-2:home", "home", 45, 20),
      mkLeg("polymarket:401:spread:-2:away", "away", 50, 20),
    ], "open");
    expect(computeRealized(t, { away: 7, home: 9, total: 16 })).toBe(0);
  });
});

describe("settlement — unequal fills", () => {
  it("grades unmatched contracts directionally", () => {
    const t = mkTrade([
      mkLeg("kalshi:401:total:6.5:over", "over", 45, 40),
      mkLeg("polymarket:401:total:6.5:under", "under", 50, 30),
    ], "partial");
    expect(computeRealized(t, { away: 5, home: 5, total: 10 })).toBe(7);
    expect(computeRealized(t, { away: 2, home: 2, total: 4 })).toBe(-3);
  });
});
