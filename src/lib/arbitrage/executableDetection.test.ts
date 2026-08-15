import { describe, expect, it } from "vitest";
import type { ArbOpportunity, MatchedEvent } from "@/types/arbitrage";
import { DEFAULT_AGENT, DEFAULT_RISK } from "./seed";
import { executableOpportunityFromLiveBooks, repriceMatchedEventsFromLiveBooks } from "./executableDetection";
import type { LiveSnapshotReader } from "./execution/liveExecutionSnapshot";

const candidate = (): ArbOpportunity => ({
  id: "football:nfl-preseason:a|b:2026-08-13T00:00:00.000Z:total:40.5",
  eventKey: "football:nfl-preseason:a|b:2026-08-13T00:00:00.000Z",
  matchup: "A v B",
  marketType: "total",
  line: 40.5,
  legs: [
    {
      venueId: "kalshi", marketId: "k", nativeMarketId: "K-TICKER", nativeSide: "yes",
      outcome: "over", priceCents: 98, decimalOdds: 100 / 98, impliedProbability: 0.98,
      size: 6, feeCents: 0, liquidityUsd: 1_000, label: "over 40.5",
    },
    {
      venueId: "polymarket", marketId: "p", nativeMarketId: "P-MARKET", nativeSide: "P-TOKEN",
      outcome: "under", priceCents: 1, decimalOdds: 100, impliedProbability: 0.01,
      size: 6, feeCents: 0, liquidityUsd: 1_000, label: "under 40.5",
    },
  ],
  totalCostCents: 99,
  grossEdge: 0.0101,
  netEdge: 0.008,
  fees: [],
  depthLimit: 6,
  stakePlan: { method: "equal_profit", totalStake: 5.94, legSizes: {}, guaranteedPayout: 6, expectedProfit: 0.05, profitPerLeg: 0.05 },
  quoteFreshness: 0,
  agentId: DEFAULT_AGENT.id,
  status: "tracked",
  detectedAt: new Date(10_000).toISOString(),
  segment: "full_game",
});

function reader(polyContracts = 500): LiveSnapshotReader {
  return (leg) => leg.venueId === "polymarket"
    ? { levels: [{ priceCents: 1, contracts: polyContracts }], updatedAt: 9_990 }
    : { levels: [{ priceCents: 98, contracts: 500 }], updatedAt: 9_995 };
}

describe("native executable opportunity detection", () => {
  it("scales a 1c Polymarket leg to the $1.01 floor before declaring it executable", () => {
    const result = executableOpportunityFromLiveBooks(
      candidate(),
      { ...DEFAULT_AGENT, minEdge: 0, maxEdge: 1 },
      { ...DEFAULT_RISK, minLiquidityUsd: 0 },
      reader(),
      10_000
    );
    expect(result.opportunity).not.toBeNull();
    expect(result.opportunity!.legs.map((leg) => leg.size)).toEqual([101, 101]);
    const poly = result.opportunity!.legs.find((leg) => leg.venueId === "polymarket")!;
    expect((poly.size * poly.priceCents) / 100).toBe(1.01);
    expect(result.opportunity!.stakePlan.expectedProfit).toBeGreaterThanOrEqual(DEFAULT_RISK.minExpectedProfitUsd);
  });

  it("rejects before execution when buffered depth cannot satisfy the Polymarket floor", () => {
    const result = executableOpportunityFromLiveBooks(
      candidate(),
      { ...DEFAULT_AGENT, minEdge: 0, maxEdge: 1 },
      DEFAULT_RISK,
      reader(50),
      10_000
    );
    expect(result.opportunity).toBeNull();
    expect(result.reason).toContain("venue minimum");
  });

  it("reprices known matched legs from native top asks before arb selection", () => {
    const matched: MatchedEvent[] = [{
      eventKey: "e", matchup: "A v B", sport: "football", league: "nfl-preseason",
      startWindow: "2026-08-13T00:00:00.000Z", canonicalTeams: ["A", "B"], marketType: "total",
      line: 40.5, venues: ["kalshi", "polymarket"], confidence: 1,
      legs: candidate().legs.map((leg) => ({
        venueId: leg.venueId, marketId: leg.marketId, nativeMarketId: leg.nativeMarketId,
        nativeSide: leg.nativeSide, marketType: "total", teams: ["A", "B"], outcome: leg.outcome,
        line: 40.5, priceCents: 50, decimalOdds: 2, impliedProbability: 0.5,
        liquidityUsd: 1, label: leg.label ?? leg.outcome,
      })),
    }];
    const repriced = repriceMatchedEventsFromLiveBooks(matched, reader());
    expect(repriced[0].legs.map((leg) => leg.priceCents)).toEqual([98, 1]);
    expect(repriced[0].legs.every((leg) => leg.liquidityUsd > 1)).toBe(true);
  });
});
