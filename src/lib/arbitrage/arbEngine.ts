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
  MarketType,
  MatchedEvent,
  MatchedLeg,
  Outcome,
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
  marketType: MarketType;
  line: number;
  reason: ReasonCode;
  netEdge: number;
  grossEdge: number;
  totalCostCents: number;
  expectedProfit: number;
  liquidityUsd: number;
  requiredLiquidityUsd: number;
  // Human-readable price equation, e.g. "kalshi over 8.5 48.00c + sxbet under 8.5 49.00c = 97.00c".
  equation: string;
  detail: string;
};

export type ArbDetectionResult = {
  opportunities: ArbOpportunity[];
  rejects: ArbReject[];
  watch: MainLineWatch[];
};

export type ArbRiskFilters = {
  minLiquidityUsd?: number;
  minExpectedProfitUsd?: number;
  liquidityStakeBufferMultiple?: number;
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

// The full set of complementary outcomes a market must cover for a guaranteed arb.
// Soccer moneyline is 3-way (1X2) — a home/away-only "arb" on a soccer match is NOT an
// arb, because the draw would lose both legs. Everything else is 2-way.
function requiredOutcomes(ev: MatchedEvent): Outcome[] {
  if (ev.marketType === "total") return ["over", "under"];
  if (ev.marketType === "spread") return ["home", "away"];
  return ev.sport === "soccer" ? ["home", "draw", "away"] : ["home", "away"];
}

// Pick one leg per required outcome, minimizing total cost, subject to the arb spanning
// at least TWO venues (never a single-venue "self edge"). Two legs MAY share a venue —
// e.g. a soccer 1X2 arb buying home+draw on one book and away on another — which is what
// makes 3-way arbs viable across only two venues. Returns null if any outcome is missing
// or no ≥2-venue combination exists.
function bestCrossVenueSelection(legs: MatchedLeg[], outcomes: Outcome[]): MatchedLeg[] | null {
  const byOutcome = outcomes.map((o) =>
    legs.filter((l) => l.outcome === o).sort((a, b) => a.priceCents - b.priceCents)
  );
  if (byOutcome.some((g) => g.length === 0)) return null;

  let bestLegs: MatchedLeg[] | null = null;
  let bestCost = Infinity;
  const pick = (i: number, acc: MatchedLeg[], cost: number) => {
    if (cost >= bestCost) return; // prune: can't beat the incumbent
    if (i === byOutcome.length) {
      if (new Set(acc.map((l) => l.venueId)).size >= 2) {
        bestLegs = [...acc];
        bestCost = cost;
      }
      return;
    }
    for (const leg of byOutcome[i]) {
      acc.push(leg);
      pick(i + 1, acc, cost + leg.priceCents);
      acc.pop();
    }
  };
  pick(0, [], 0);
  return bestLegs;
}

// Human-readable price equation for a candidate selection, e.g.
// "kalshi over 8.5 48.00c + sxbet under 8.5 49.00c = 97.00c".
function rejectEquation(legs: MatchedLeg[]): string {
  if (!legs.length) return "n/a";
  const cost = legs.reduce((s, l) => s + l.priceCents, 0);
  return `${legs.map((l) => `${l.venueId} ${l.label ?? l.outcome} ${l.priceCents.toFixed(2)}c`).join(" + ")} = ${cost.toFixed(2)}c`;
}

function buildLeg(m: MatchedLeg, size: number): ArbLeg {
  return {
    venueId: m.venueId,
    marketId: m.marketId,
    nativeMarketId: m.nativeMarketId,
    nativeSide: m.nativeSide,
    sourceStartTime: m.sourceStartTime,
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
  riskFilters: number | ArbRiskFilters = 0
): ArbDetectionResult {
  const minLiquidityUsd = typeof riskFilters === "number" ? riskFilters : riskFilters.minLiquidityUsd ?? 0;
  const minExpectedProfitUsd = typeof riskFilters === "number" ? 0 : riskFilters.minExpectedProfitUsd ?? 0;
  const liquidityStakeBufferMultiple =
    typeof riskFilters === "number" ? 1 : Math.max(1, riskFilters.liquidityStakeBufferMultiple ?? 1);
  const opportunities: ArbOpportunity[] = [];
  const rejects: ArbReject[] = [];
  const watch: MainLineWatch[] = [];
  const now = new Date().toISOString();

  // Evaluate every matched total line. Live games can produce real, short-lived
  // cross-venue gaps on alternate totals; the stale-divergence gate below still
  // rejects lines where venues plainly disagree on the same side.
  const totals = matched.filter((e) => e.marketType === "total");
  const others = matched.filter((e) => e.marketType !== "total");
  const mainTotalKeys = new Set(pickMainLines(totals).map((e) => `${e.eventKey}:${e.line}`));
  const candidates = [...totals, ...others];

  for (const ev of candidates) {
    const isTotal = ev.marketType === "total";
    const required = requiredOutcomes(ev);
    const selection = bestCrossVenueSelection(ev.legs, required);
    if (!selection) continue;

    // Cross-venue divergence on the first outcome group (stale-quote signal).
    const sideAByVenue = new Map<string, number>();
    for (const l of ev.legs) if (l.outcome === required[0]) sideAByVenue.set(l.venueId, l.priceCents);
    const sideAPrices = [...sideAByVenue.values()];
    const divergence = sideAPrices.length >= 2 ? Math.max(...sideAPrices) - Math.min(...sideAPrices) : 0;
    const pairLiquidity = Math.min(...selection.map((s) => s.liquidityUsd));

    // Equal-profit sizing capped by agent max stake AND executable depth. Buys the same
    // contract count on every outcome so the payout is identical whichever result hits.
    const effectiveMaxStake = Math.max(1, Math.min(agent.maxStake, pairLiquidity));
    const provisional = selection.map((m) => buildLeg(m, 0));
    const plan = equalProfitSizing(provisional, effectiveMaxStake);
    // Equal-profit sizing buys the SAME contract count on every outcome, so payout is
    // identical whichever result hits (works whether or not two legs share a venue).
    const contractsPerLeg = Math.round(plan.guaranteedPayout);
    const legs = selection.map((m) => buildLeg(m, contractsPerLeg));
    const fees = computeFees(legs);
    legs.forEach((leg, i) => (leg.feeCents = fees[i].feeCents));

    const totalCost = totalCostCents(selection.map((s) => s.priceCents));
    const gross = grossEdge(totalCost);
    const feeFrac = feeFractionOfStake(fees, plan.legSizes);
    const net = round(gross - feeFrac - SLIPPAGE_RESERVE, 6);
    const totalFeeDollars = fees.reduce((s, f) => s + f.feeCents / 100, 0);
    const expectedProfit = round(plan.guaranteedPayout - plan.totalStake - totalFeeDollars, 2);
    const requiredLiquidityUsd = Math.max(minLiquidityUsd, plan.totalStake * liquidityStakeBufferMultiple);

    // Every reject carries the full economic picture (price equation, sum, gross/net
    // edge, expected profit, pair liquidity and the depth it needed) so a rejected
    // opportunity is debuggable without string-parsing `detail`.
    const pushReject = (reason: ReasonCode, detail: string) =>
      rejects.push({
        eventKey: ev.eventKey,
        matchup: ev.matchup,
        marketType: ev.marketType,
        line: ev.line,
        reason,
        netEdge: net,
        grossEdge: gross,
        totalCostCents: totalCost,
        expectedProfit,
        liquidityUsd: pairLiquidity >= 1e8 ? 0 : Math.round(pairLiquidity),
        requiredLiquidityUsd: Math.round(requiredLiquidityUsd),
        equation: rejectEquation(selection),
        detail,
      });

    let status: MainLineWatch["status"];
    if (divergence > STALE_DIVERGENCE_CENTS) status = "stale";
    else if (
      totalCost < 100 &&
      pairLiquidity >= requiredLiquidityUsd &&
      expectedProfit >= minExpectedProfitUsd &&
      net >= agent.minEdge &&
      net <= agent.maxEdge
    )
      status = "arb";
    else status = "no_edge";

    // Watch board is the per-game main total monitor (totals only).
    if (isTotal && mainTotalKeys.has(`${ev.eventKey}:${ev.line}`)) {
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
      pushReject("stale_quote", `venues disagree ${divergence}c — likely stale`);
    } else if (totalCost < 100 && pairLiquidity < requiredLiquidityUsd) {
      pushReject("insufficient_depth", `executable $${Math.round(pairLiquidity)} < required $${Math.round(requiredLiquidityUsd)} (${liquidityStakeBufferMultiple}x stake buffer)`);
    } else if (totalCost < 100 && expectedProfit < minExpectedProfitUsd) {
      pushReject("edge_below_min", `expected profit $${expectedProfit.toFixed(2)} < min $${minExpectedProfitUsd.toFixed(2)}`);
    } else if (net > agent.maxEdge) {
      pushReject("edge_above_max", `net ${(net * 100).toFixed(2)}% > max`);
    } else if (totalCost < 100 && net < agent.minEdge) {
      pushReject("edge_below_min", `net ${(net * 100).toFixed(2)}% < min`);
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
