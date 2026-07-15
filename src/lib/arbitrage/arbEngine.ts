// Arb engine (manual §7-§9). Consumes matched two-way markets and detects guaranteed
// cross-venue pairs at identical lines. Inputs are executable top-book asks/depth;
// the execution pipeline still walks the complete books immediately before ordering.

import type {
  Agent,
  ArbLeg,
  ArbOpportunity,
  MainLineWatch,
  MatchedEvent,
  MatchedLeg,
  ReasonCode,
} from "@/types/arbitrage";
import {
  decimalOddsFromCents,
  grossEdge,
  impliedProbFromCents,
  totalCostCents,
} from "./arbMath";
import { computeFees, feeFractionOfStake } from "./feeEngine";

// Legs are now priced at the executable ask, which already includes the bid/ask
// spread cost — so no separate mid-era slippage buffer.
const SLIPPAGE_RESERVE = 0;

export type ArbReject = {
  eventKey: string;
  matchup: string;
  line: number;
  reason: ReasonCode;
  netEdge: number;
  detail: string;
};

export type ArbDetectionResult = {
  opportunities: ArbOpportunity[];
  rejects: ArbReject[];
  watch: MainLineWatch[];
};

// Cross-venue over-price divergence beyond which a main-line quote is treated as
// stale (venues agree closely on the actively-traded main total; a big gap means
// one side is stale/mispriced, which is what fabricates tail-line phantom arbs).
const STALE_DIVERGENCE_CENTS = 15;

// Per game, pick the single MAIN total line — the shared line whose over price is
// closest to 50/50. That's the actively-traded, accurately-priced line (≈7.5-9.5 for
// MLB, and it drifts as runs score). Anchor on Kalshi's over price (its ladder is
// reliable); Polymarket's tail quotes can be stale and would skew a blended average.
const REFERENCE_VENUE = "kalshi";

function pickMainLines(matched: MatchedEvent[]): MatchedEvent[] {
  const byEvent = new Map<string, MatchedEvent[]>();
  for (const ev of matched) {
    const arr = byEvent.get(ev.eventKey) ?? [];
    arr.push(ev);
    byEvent.set(ev.eventKey, arr);
  }
  const main: MatchedEvent[] = [];
  for (const evs of byEvent.values()) {
    let best: MatchedEvent | null = null;
    let bestScore = Infinity;
    for (const ev of evs) {
      const overs = ev.legs.filter((l) => l.outcome === "over");
      if (!overs.length) continue;
      const ref = overs.find((l) => l.venueId === REFERENCE_VENUE) ?? overs[0];
      const score = Math.abs(ref.impliedProbability - 0.5);
      if (score < bestScore) {
        bestScore = score;
        best = ev;
      }
    }
    if (best) main.push(best);
  }
  return main;
}

// Choose the cheapest cross-venue pairing of the two complementary outcomes
// (over/under for totals, home/away for moneyline). Outcome-agnostic.
function crossVenuePairs(legs: MatchedLeg[]): Array<{ a: MatchedLeg; b: MatchedLeg }> {
  const outcomes = [...new Set(legs.map((l) => l.outcome))];
  if (outcomes.length !== 2) return [];
  const sideA = legs.filter((l) => l.outcome === outcomes[0]);
  const sideB = legs.filter((l) => l.outcome === outcomes[1]);
  const pairs: Array<{ a: MatchedLeg; b: MatchedLeg }> = [];
  for (const a of sideA) {
    for (const b of sideB) {
      if (a.venueId === b.venueId) continue; // no intra-venue self edge
      pairs.push({ a, b });
    }
  }
  return pairs;
}

function buildLeg(m: MatchedLeg, size: number): ArbLeg {
  return {
    venueId: m.venueId,
    marketId: m.marketId,
    nativeMarketId: m.nativeMarketId,
    nativeSide: m.nativeSide,
    outcome: m.outcome,
    priceCents: m.priceCents,
    decimalOdds: decimalOddsFromCents(m.priceCents),
    impliedProbability: impliedProbFromCents(m.priceCents),
    size,
    feeCents: 0,
    liquidityUsd: m.liquidityUsd,
    label: m.label,
  };
}

type PairPlan = {
  pair: { a: MatchedLeg; b: MatchedLeg };
  pairLiquidity: number;
  contracts: number;
  legs: ArbLeg[];
  legSizes: Record<string, number>;
  totalStake: number;
  fees: ReturnType<typeof computeFees>;
  totalCost: number;
  gross: number;
  net: number;
  expectedProfit: number;
};

function buildPairPlan(pair: { a: MatchedLeg; b: MatchedLeg }, agent: Agent): PairPlan {
  const pairLiquidity = Math.min(pair.a.liquidityUsd, pair.b.liquidityUsd);
  const priceSumDollars = (pair.a.priceCents + pair.b.priceCents) / 100;
  const stakeContracts = priceSumDollars > 0 ? Math.floor(agent.maxStake / priceSumDollars) : 0;
  const depthContracts = Math.min(
    Math.floor(pair.a.liquidityUsd / (pair.a.priceCents / 100)),
    Math.floor(pair.b.liquidityUsd / (pair.b.priceCents / 100))
  );
  const contracts = Math.max(0, Math.min(stakeContracts, depthContracts));
  const legs = [buildLeg(pair.a, contracts), buildLeg(pair.b, contracts)];
  const legSizes: Record<string, number> = {};
  for (const leg of legs) legSizes[leg.venueId] = round((leg.size * leg.priceCents) / 100, 2);
  const totalStake = round(Object.values(legSizes).reduce((sum, value) => sum + value, 0), 2);
  const fees = computeFees(legs);
  legs.forEach((leg, index) => (leg.feeCents = fees[index].feeCents));
  const totalCost = totalCostCents([pair.a.priceCents, pair.b.priceCents]);
  const gross = grossEdge(totalCost);
  const feeFrac = feeFractionOfStake(fees, legSizes);
  const net = round(gross - feeFrac - SLIPPAGE_RESERVE, 6);
  const totalFeeDollars = fees.reduce((sum, fee) => sum + fee.feeCents / 100, 0);

  return {
    pair,
    pairLiquidity,
    contracts,
    legs,
    legSizes,
    totalStake,
    fees,
    totalCost,
    gross,
    net,
    expectedProfit: round(contracts - totalStake - totalFeeDollars, 2),
  };
}

function bestPairPlan(legs: MatchedLeg[], agent: Agent, minLiquidityUsd: number): PairPlan | null {
  const plans = crossVenuePairs(legs).map((pair) => buildPairPlan(pair, agent));
  if (plans.length === 0) return null;
  // Prefer executable depth, then rank every candidate by fee-adjusted return.
  const executable = plans.filter((plan) => plan.contracts > 0 && plan.pairLiquidity >= minLiquidityUsd);
  const pool = executable.length > 0 ? executable : plans;
  return pool.sort((a, b) => b.net - a.net || b.contracts - a.contracts)[0];
}

export function detectArbs(
  matched: MatchedEvent[],
  agent: Agent,
  minLiquidityUsd = 0
): ArbDetectionResult {
  const opportunities: ArbOpportunity[] = [];
  const rejects: ArbReject[] = [];
  const watch: MainLineWatch[] = [];
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  // Totals: one main line per game. Moneyline: the single market per game.
  const totals = matched.filter((e) => e.marketType === "total");
  const others = matched.filter((e) => e.marketType !== "total");
  const candidates = [...pickMainLines(totals), ...others];

  for (const ev of candidates) {
    const isTotal = ev.marketType === "total";
    const plan = bestPairPlan(ev.legs, agent, minLiquidityUsd);
    if (!plan) continue;
    const { pair, pairLiquidity, contracts, legs, legSizes, totalStake, fees, totalCost, gross, net, expectedProfit } = plan;

    // Cross-venue divergence on the first outcome group (stale-quote signal).
    const outcomes = [...new Set(ev.legs.map((l) => l.outcome))];
    const sideAByVenue = new Map<string, number>();
    for (const l of ev.legs) if (l.outcome === outcomes[0]) sideAByVenue.set(l.venueId, l.priceCents);
    const sideAPrices = [...sideAByVenue.values()];
    const divergence = sideAPrices.length >= 2 ? Math.max(...sideAPrices) - Math.min(...sideAPrices) : 0;
    const quoteFreshness = Math.max(
      ...[pair.a, pair.b].map((leg) => {
        const captured = Date.parse(leg.lastUpdated);
        return Number.isFinite(captured) ? Math.max(0, nowMs - captured) : Number.POSITIVE_INFINITY;
      })
    );

    let status: MainLineWatch["status"];
    if (divergence > STALE_DIVERGENCE_CENTS || quoteFreshness > agent.staleQuoteMs) status = "stale";
    else if (contracts > 0 && totalCost < 100 && pairLiquidity >= minLiquidityUsd && net >= agent.minEdge && net <= agent.maxEdge)
      status = "arb";
    else status = "no_edge";

    // Watch board is the per-game main total monitor (totals only).
    if (isTotal) {
      const overByVenue = new Map<string, number>();
      const underByVenue = new Map<string, number>();
      for (const l of ev.legs) {
        if (l.outcome === "over") overByVenue.set(l.venueId, l.priceCents);
        else if (l.outcome === "under") underByVenue.set(l.venueId, l.priceCents);
      }
      watch.push({
        eventKey: ev.eventKey,
        matchup: ev.matchup,
        line: ev.line,
        venuePrices: [...new Set([...overByVenue.keys(), ...underByVenue.keys()])].map((v) => ({
          venueId: v,
          overCents: overByVenue.get(v) ?? null,
          underCents: underByVenue.get(v) ?? null,
        })),
        totalCostCents: totalCost,
        grossEdge: gross,
        netEdge: net,
        divergenceCents: divergence,
        liquidityUsd: Math.round(pairLiquidity),
        status,
      });
    }

    const line = ev.marketType === "moneyline" ? null : ev.line;
    if (status === "arb") {
      opportunities.push({
        id: `${ev.eventKey}:${ev.marketType}:${ev.line}`,
        eventKey: ev.eventKey,
        matchup: ev.matchup,
        marketType: ev.marketType,
        line,
        legs,
        totalCostCents: totalCost,
        grossEdge: gross,
        netEdge: net,
        fees,
        depthLimit: Math.min(...legs.map((l) => l.size)) || 0,
        stakePlan: {
          method: "equal_profit",
          totalStake,
          legSizes,
          guaranteedPayout: contracts,
          expectedProfit,
          profitPerLeg: expectedProfit,
        },
        quoteFreshness,
        agentId: agent.id,
        status: "tracked",
        detectedAt: now,
      });
    } else if (status === "stale") {
      const detail = quoteFreshness > agent.staleQuoteMs
        ? `oldest quote ${quoteFreshness}ms > ${agent.staleQuoteMs}ms`
        : `venues disagree ${divergence}c — likely stale`;
      rejects.push({ eventKey: ev.eventKey, matchup: ev.matchup, line: ev.line, reason: "stale_quote", netEdge: net, detail });
    } else if (totalCost < 100 && (pairLiquidity < minLiquidityUsd || contracts === 0)) {
      rejects.push({ eventKey: ev.eventKey, matchup: ev.matchup, line: ev.line, reason: "insufficient_depth", netEdge: net, detail: `executable $${Math.round(pairLiquidity)} < min $${minLiquidityUsd}` });
    } else if (net > agent.maxEdge) {
      rejects.push({ eventKey: ev.eventKey, matchup: ev.matchup, line: ev.line, reason: "edge_above_max", netEdge: net, detail: `net ${(net * 100).toFixed(2)}% > max` });
    } else if (totalCost < 100 && net < agent.minEdge) {
      rejects.push({ eventKey: ev.eventKey, matchup: ev.matchup, line: ev.line, reason: "edge_below_min", netEdge: net, detail: `net ${(net * 100).toFixed(2)}% < min` });
    }
  }

  opportunities.sort((a, b) => b.netEdge - a.netEdge);
  watch.sort((a, b) => b.netEdge - a.netEdge);
  return { opportunities, rejects, watch };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
