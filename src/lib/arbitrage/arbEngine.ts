// Phase 5 arb engine (manual §7-§9). Consumes matched events and detects guaranteed
// cross-venue arbitrage on game totals: buy OVER on one venue + UNDER on the other
// at the same line, where p_over + p_under < 1 after fees. Builds an equal-profit
// stake plan and applies the agent's min/max edge gates.
//
// Pure functions — no I/O. Prices are the current normalized quotes; executable
// ask/depth-aware pricing is a later refinement.

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
  equalProfitSizing,
  grossEdge,
  impliedProbFromCents,
  totalCostCents,
} from "./arbMath";
import { computeFees, feeFractionOfStake } from "./feeEngine";

// Legs are now priced at the executable ask, which already includes the bid/ask
// spread cost — so no separate mid-era slippage buffer. A small residual reserve
// covers depth walk beyond top-of-book (proper depth-aware sizing is a later phase).
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
function bestCrossVenuePair(legs: MatchedLeg[]): { a: MatchedLeg; b: MatchedLeg } | null {
  const outcomes = [...new Set(legs.map((l) => l.outcome))];
  if (outcomes.length !== 2) return null;
  const sideA = legs.filter((l) => l.outcome === outcomes[0]);
  const sideB = legs.filter((l) => l.outcome === outcomes[1]);
  let best: { a: MatchedLeg; b: MatchedLeg; cost: number } | null = null;
  for (const a of sideA) {
    for (const b of sideB) {
      if (a.venueId === b.venueId) continue; // no intra-venue self edge
      const cost = a.priceCents + b.priceCents;
      if (!best || cost < best.cost) best = { a, b, cost };
    }
  }
  return best ? { a: best.a, b: best.b } : null;
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

export function detectArbs(
  matched: MatchedEvent[],
  agent: Agent,
  minLiquidityUsd = 0
): ArbDetectionResult {
  const opportunities: ArbOpportunity[] = [];
  const rejects: ArbReject[] = [];
  const watch: MainLineWatch[] = [];
  const now = new Date().toISOString();

  // Totals: one main line per game. Moneyline: the single market per game.
  const totals = matched.filter((e) => e.marketType === "total");
  const others = matched.filter((e) => e.marketType !== "total");
  const candidates = [...pickMainLines(totals), ...others];

  for (const ev of candidates) {
    const isTotal = ev.marketType === "total";
    const pair = bestCrossVenuePair(ev.legs);
    if (!pair) continue;

    // Cross-venue divergence on the first outcome group (stale-quote signal).
    const outcomes = [...new Set(ev.legs.map((l) => l.outcome))];
    const sideAByVenue = new Map<string, number>();
    for (const l of ev.legs) if (l.outcome === outcomes[0]) sideAByVenue.set(l.venueId, l.priceCents);
    const sideAPrices = [...sideAByVenue.values()];
    const divergence = sideAPrices.length >= 2 ? Math.max(...sideAPrices) - Math.min(...sideAPrices) : 0;
    const pairLiquidity = Math.min(pair.a.liquidityUsd, pair.b.liquidityUsd);

    // Equal-profit sizing capped by agent max stake AND executable depth.
    const effectiveMaxStake = Math.max(1, Math.min(agent.maxStake, pairLiquidity));
    const provisional = [pair.a, pair.b].map((m) => buildLeg(m, 0));
    const plan = equalProfitSizing(provisional, effectiveMaxStake);
    const legs = [pair.a, pair.b].map((m) => {
      const dollars = plan.legSizes[m.venueId] ?? 0;
      const contracts = m.priceCents > 0 ? Math.round(dollars / (m.priceCents / 100)) : 0;
      return buildLeg(m, contracts);
    });
    const fees = computeFees(legs);
    legs.forEach((leg, i) => (leg.feeCents = fees[i].feeCents));

    const totalCost = totalCostCents([pair.a.priceCents, pair.b.priceCents]);
    const gross = grossEdge(totalCost);
    const feeFrac = feeFractionOfStake(fees, plan.legSizes);
    const net = round(gross - feeFrac - SLIPPAGE_RESERVE, 6);
    const totalFeeDollars = fees.reduce((s, f) => s + f.feeCents / 100, 0);
    const expectedProfit = round(plan.guaranteedPayout - plan.totalStake - totalFeeDollars, 2);

    let status: MainLineWatch["status"];
    if (divergence > STALE_DIVERGENCE_CENTS) status = "stale";
    else if (totalCost < 100 && pairLiquidity >= minLiquidityUsd && net >= agent.minEdge && net <= agent.maxEdge)
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
        liquidityUsd: pairLiquidity >= 1e8 ? 0 : Math.round(pairLiquidity),
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
        stakePlan: { ...plan, expectedProfit },
        quoteFreshness: 0,
        agentId: agent.id,
        status: "tracked",
        detectedAt: now,
      });
    } else if (status === "stale") {
      rejects.push({ eventKey: ev.eventKey, matchup: ev.matchup, line: ev.line, reason: "stale_quote", netEdge: net, detail: `venues disagree ${divergence}c — likely stale` });
    } else if (totalCost < 100 && pairLiquidity < minLiquidityUsd) {
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
