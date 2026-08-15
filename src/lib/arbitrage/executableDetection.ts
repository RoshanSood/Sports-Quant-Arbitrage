import type { Agent, ArbLeg, ArbOpportunity, MatchedEvent, MatchedLeg, RiskSettings, VenueId } from "@/types/arbitrage";
import { computeFees } from "./feeEngine";
import { decimalOddsFromCents, executedEconomics, grossEdge, impliedProbFromCents, venueMinStakeScale } from "./arbMath";
import { optimizeExecutableBasket } from "./execution/executor";
import {
  captureLiveExecutionSnapshot,
  currentLiveSnapshotForLeg,
  isPolymarketKalshiNativePair,
  LIVE_EXECUTION_SNAPSHOT_FRESH_MS,
  type LiveSnapshotReader,
} from "./execution/liveExecutionSnapshot";
import type { ExecutableOrderQuote, OrderRequest } from "./execution/types";

export type ExecutableDetectionReject = {
  opportunity: ArbOpportunity;
  reason: string;
};

function legSnapshotInput(leg: MatchedLeg): ArbLeg {
  return {
    ...leg,
    size: 1,
    feeCents: 0,
  };
}

// Discovery still comes from REST, but every known Polymarket/Kalshi leg is repriced from
// its native ask ladder before arb selection. This lets a websocket delta create or remove
// an opportunity without waiting for another full venue ingest.
export function repriceMatchedEventsFromLiveBooks(
  matched: MatchedEvent[],
  reader: LiveSnapshotReader = currentLiveSnapshotForLeg
): MatchedEvent[] {
  return matched.map((event) => ({
    ...event,
    legs: event.legs.map((leg) => {
      if (leg.venueId !== "polymarket" && leg.venueId !== "kalshi") return leg;
      const snapshot = reader(legSnapshotInput(leg));
      const bestAsk = snapshot?.levels[0];
      if (!snapshot?.levels.length || !bestAsk) return leg;
      const liquidityUsd = snapshot.levels.reduce(
        (sum, level) => sum + (level.priceCents * level.contracts) / 100,
        0
      );
      return {
        ...leg,
        priceCents: bestAsk.priceCents,
        decimalOdds: decimalOddsFromCents(bestAsk.priceCents),
        impliedProbability: impliedProbFromCents(bestAsk.priceCents),
        liquidityUsd,
      };
    }),
  }));
}

function requestFor(leg: ArbLeg, sizeContracts: number): OrderRequest {
  return {
    venueId: leg.venueId,
    marketId: leg.marketId,
    nativeMarketId: leg.nativeMarketId,
    nativeSide: leg.nativeSide,
    outcome: leg.outcome,
    sizeContracts,
    limitPriceCents: leg.priceCents,
  };
}

function legSizes(legs: ArbLeg[]): Record<VenueId, number> {
  const result: Record<VenueId, number> = {};
  for (const leg of legs) {
    result[leg.venueId] = round((result[leg.venueId] ?? 0) + (leg.size * leg.priceCents) / 100, 2);
  }
  return result;
}

// Turn an indicative candidate into the exact basket the executor would be allowed to
// submit. It walks full ladders, applies the depth buffer, venue minimums, fees, fixed-point
// price ceilings, equal contracts, and the existing profit/edge thresholds. Returning null
// means the scanner must not expose or enqueue the candidate as an arb.
export function executableOpportunityFromLiveBooks(
  opportunity: ArbOpportunity,
  agent: Agent,
  risk: RiskSettings,
  reader: LiveSnapshotReader = currentLiveSnapshotForLeg,
  now = Date.now()
): { opportunity: ArbOpportunity | null; reason: string } {
  if (!isPolymarketKalshiNativePair(opportunity.legs)) {
    return { opportunity, reason: "native executable detection is not available for this venue pair" };
  }

  const scale = venueMinStakeScale(opportunity.legs).scale;
  const requestedContracts = Math.ceil(Math.max(...opportunity.legs.map((leg) => leg.size * scale)) * 100) / 100;
  const requests = opportunity.legs.map((leg) => requestFor(leg, requestedContracts));
  const snapshotResult = captureLiveExecutionSnapshot(
    opportunity.legs,
    reader,
    now,
    Math.min(risk.staleQuoteMs, LIVE_EXECUTION_SNAPSHOT_FRESH_MS),
    1
  );
  if (!snapshotResult.snapshot) return { opportunity: null, reason: snapshotResult.reason };

  const quotes: ExecutableOrderQuote[] = requests.map((request) => {
    const snapshotLeg = snapshotResult.snapshot!.legs.find((leg) => leg.marketId === request.marketId)!;
    const availableContracts = snapshotLeg.levels.reduce((sum, level) => sum + level.contracts, 0);
    return {
      ok: availableContracts + 1e-9 >= request.sizeContracts,
      priceCents: snapshotLeg.levels.at(-1)?.priceCents ?? request.limitPriceCents,
      averagePriceCents: snapshotLeg.levels[0]?.priceCents ?? request.limitPriceCents,
      availableContracts,
      levels: snapshotLeg.levels.map((level) => ({ ...level })),
    };
  });
  const optimized = optimizeExecutableBasket(
    requests,
    quotes,
    Math.max(1, risk.liquidityStakeBufferMultiple),
    risk.minExpectedProfitUsd
  );
  if (optimized.blockers.length) return { opportunity: null, reason: optimized.blockers.join("; ") };

  const legs = opportunity.legs.map((leg, index): ArbLeg => ({
    ...leg,
    size: optimized.commonContracts,
    priceCents: optimized.averagePriceCents[index],
    decimalOdds: decimalOddsFromCents(optimized.averagePriceCents[index]),
    impliedProbability: impliedProbFromCents(optimized.averagePriceCents[index]),
    feeCents: 0,
  }));
  const fees = computeFees(legs);
  legs.forEach((leg, index) => (leg.feeCents = fees[index].feeCents));
  const economics = executedEconomics(legs);
  const totalCostCents = round(optimized.averagePriceCents.reduce((sum, price) => sum + price, 0), 4);
  const netEdge = economics.totalCost > 0 ? economics.expectedProfit / economics.totalCost : 0;
  if (netEdge + 1e-9 < agent.minEdge) return { opportunity: null, reason: `executable net edge ${(netEdge * 100).toFixed(2)}% is below minimum` };
  if (netEdge - 1e-9 > agent.maxEdge) return { opportunity: null, reason: `executable net edge ${(netEdge * 100).toFixed(2)}% is above maximum` };

  return {
    opportunity: {
      ...opportunity,
      legs,
      totalCostCents,
      grossEdge: grossEdge(totalCostCents),
      netEdge: round(netEdge, 6),
      fees,
      depthLimit: optimized.commonContracts,
      stakePlan: {
        method: "equal_profit",
        totalStake: economics.totalCost,
        legSizes: legSizes(legs),
        guaranteedPayout: economics.guaranteedPayout,
        expectedProfit: economics.expectedProfit,
        profitPerLeg: economics.expectedProfit,
      },
      quoteFreshness: snapshotResult.snapshot.oldestAgeMs,
      detectedAt: new Date(now).toISOString(),
    },
    reason: `executable on native ladders at ${optimized.commonContracts.toFixed(2)} contracts`,
  };
}

export function filterExecutableOpportunities(
  opportunities: ArbOpportunity[],
  agent: Agent,
  risk: RiskSettings,
  reader: LiveSnapshotReader = currentLiveSnapshotForLeg,
  now = Date.now()
): { opportunities: ArbOpportunity[]; rejected: ExecutableDetectionReject[] } {
  const executable: ArbOpportunity[] = [];
  const rejected: ExecutableDetectionReject[] = [];
  for (const candidate of opportunities) {
    const result = executableOpportunityFromLiveBooks(candidate, agent, risk, reader, now);
    if (result.opportunity) executable.push(result.opportunity);
    else rejected.push({ opportunity: candidate, reason: result.reason });
  }
  return { opportunities: executable.sort((a, b) => b.netEdge - a.netEdge), rejected };
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
