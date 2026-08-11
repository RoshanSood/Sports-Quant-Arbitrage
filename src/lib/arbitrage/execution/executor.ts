// The real executor. Runs the shared pre-execution checks, resolves the effective
// mode through the safety gate (defaults to dry-run unless EVERY live switch is on),
// then places each leg through its venue adapter and records the Trade + log. Dry-run
// and live share this exact path — only the adapter differs.

import type { ArbLeg, ExecutionStep, Trade } from "@/types/arbitrage";
import { saveTrade } from "../tradeStore";
import { prepareExecution, verifyPostFill, writeLog, type ExecutionOutcome, type PreparedContext } from "../executionPipeline";
import { resolveExecutionMode, SXBET_MIN_TAKER_STAKE_USD, type ExecMode } from "./config";
import { getAdapter, venueSupportsLive, type ExecCreds } from "./registry";
import { applyReconciliation, reconcileLegs, type LegReconciliation } from "./reconcile";
import { computeFees } from "../feeEngine";
import { executedEconomics, venueMinContracts, venueMinStakeUsd } from "../arbMath";
import { polymarketLiveBook } from "../polymarketLiveBook";
import { kalshiLiveBook } from "../kalshiLiveBook";
import type { ExecutableOrderQuote, ExecutionAdapter, OrderRequest, OrderResult } from "./types";

// Live-book reads for checkLiveFillability, keyed off the real singletons (ingest.ts keeps
// both connected + subscribed to today's markets). A thin adapter over each venue's own
// key shape — see LiveBookReader's doc comment for why the two venues are keyed differently.
function liveAskCentsFor(req: OrderRequest): number | null {
  if (req.venueId === "polymarket" && req.nativeSide) {
    return polymarketLiveBook.getQuote(req.nativeSide)?.bestAskCents ?? null;
  }
  if (req.venueId === "kalshi" && req.nativeMarketId && req.nativeSide) {
    const q = kalshiLiveBook.getQuote(req.nativeMarketId);
    if (!q) return null;
    return req.nativeSide.toLowerCase() === "no" ? q.noAskCents : q.yesAskCents;
  }
  return null;
}

function liveDepthAtOrBetter(req: OrderRequest, limitPriceCents: number): number | null {
  if (req.venueId === "polymarket" && req.nativeSide) {
    return polymarketLiveBook.getDepth(req.nativeSide, "ask", limitPriceCents);
  }
  if (req.venueId === "kalshi" && req.nativeMarketId && req.nativeSide) {
    const side = req.nativeSide.toLowerCase() === "no" ? "no" : "yes";
    return kalshiLiveBook.getDepth(req.nativeMarketId, side, limitPriceCents);
  }
  return null;
}

// Max extra we'll pay per contract to match a live ask that moved since detection, using the
// ALREADY-CONNECTED live-book websocket caches (in-memory reads, ~0ms) instead of a fresh
// network call. The old Polymarket "book preflight" (removed) did a REST order-book read
// right before firing, and THAT round-trip's latency is what let the book move even further
// and killed ~100% of Polymarket fills when it was live. This is different in kind: no
// network call, just a fresher price/size for the exact same single-shot order. The price
// nudge is bounded to a couple cents so a real arb-invalidating move (not a routine tick) is
// left to abort rather than blindly chased past what the edge can absorb.
export const LIVE_PRICE_CUSHION_CENTS = 2;

// One leg's live-book read, keyed off the OrderRequest itself (Polymarket's book is keyed by
// nativeSide alone — it's the CLOB token id; Kalshi's is keyed by nativeMarketId [ticker] +
// nativeSide [yes/no]). Returns null when there's no live data — callers must treat null as
// "unknown", never as "zero" (a fail-safe read, not a fail-safe answer).
export type LiveBookReader = {
  askCents: (req: OrderRequest) => number | null;
  depthAtOrBetter: (req: OrderRequest, limitPriceCents: number) => number | null;
};

export type LiveFillabilityResult = {
  requests: OrderRequest[]; // price-nudged where the live ask moved within the cushion
  blockers: string[]; // non-empty => abort the WHOLE trade, don't fire ANY leg
  adjustments: Array<{ venueId: string; fromCents: number; toCents: number }>;
};

// Pure — takes live reads as a parameter so it's testable without the singletons. For each
// Polymarket/Kalshi leg: (1) if the live ask moved against us within the cushion, nudge the
// limit to match (never loosens an already-favorable limit); if it moved beyond the cushion,
// block outright rather than chase. (2) if we have a live depth reading at the (possibly
// nudged) limit and it's short of the required size, block. Missing live data (either check)
// is not itself a blocker — this supplements the existing REST-based min_depth gate, it
// doesn't replace it.
export function checkLiveFillability(requests: OrderRequest[], live: LiveBookReader): LiveFillabilityResult {
  const blockers: string[] = [];
  const adjustments: LiveFillabilityResult["adjustments"] = [];
  const next = requests.map((r) => {
    if (r.venueId !== "polymarket" && r.venueId !== "kalshi") return r;
    let limitPriceCents = r.limitPriceCents;
    const liveAsk = live.askCents(r);
    if (liveAsk != null && liveAsk > limitPriceCents) {
      const bumped = Math.min(99, liveAsk);
      adjustments.push({ venueId: r.venueId, fromCents: limitPriceCents, toCents: bumped });
      limitPriceCents = bumped;
    }
    // A short websocket cache is an optimization input, not an immediate rejection. The
    // fresh venue-native ladder pass below may find a profitable smaller common basket.
    live.depthAtOrBetter(r, limitPriceCents);
    return limitPriceCents === r.limitPriceCents ? r : { ...r, limitPriceCents };
  });
  return { requests: next, blockers, adjustments };
}

// One leg's live ask ladder, keyed off the OrderRequest — same venue-keying split as
// LiveBookReader (Polymarket by nativeSide/token id, Kalshi by nativeMarketId + side).
export type LiveLevelsReader = (req: OrderRequest) => Array<{ priceCents: number; contracts: number }> | null;

export type LiveOnlyQuotesResult = {
  quotes: Array<ExecutableOrderQuote | null>; // per-leg; null where live data was missing/insufficient
  canSkipRestProbe: boolean; // true only when EVERY leg got a live quote covering its full size
};

// Pure — takes the live ladder lookup as a parameter so it's testable without the
// singletons. For each request, build a fully-executable quote from the live-book ladder
// ALONE if (and only if) it covers the requested size; otherwise that leg is null. Callers
// should only trust the whole batch (skip the REST probe) when every leg came back
// non-null — a partial live picture is not enough to skip verifying the rest via REST,
// since a mixed basket still needs the REST-quoted legs' real numbers regardless.
export function buildLiveOnlyQuotes(requests: OrderRequest[], liveLevelsFor: LiveLevelsReader): LiveOnlyQuotesResult {
  const quotes = requests.map((request): ExecutableOrderQuote | null => {
    const levels = liveLevelsFor(request);
    if (!levels?.length) return null;
    const availableContracts = levels.reduce((sum, level) => sum + level.contracts, 0);
    if (availableContracts + 1e-9 < request.sizeContracts) return null;
    return { ok: true, priceCents: levels[0].priceCents, averagePriceCents: levels[0].priceCents, availableContracts, levels };
  });
  return { quotes, canSkipRestProbe: quotes.every((q) => q != null) };
}

// Re-exported for callers/tests that reference it from the executor module.
export { SXBET_MIN_TAKER_STAKE_USD };

// Final safety-net check right before placement: every leg on a $-minimum venue (SX.bet,
// Polymarket) must actually clear that minimum at its EXECUTED size. executionPipeline.ts's
// venueMinStakeScale already sizes the whole arb up to satisfy this before we get here — this
// just refuses to fire if that somehow didn't happen (e.g. a caller that skipped prepareExecution).
export function liveVenueMinimumStakeBlockers(legs: ArbLeg[]): string[] {
  return legs.flatMap((leg) => {
    const min = venueMinStakeUsd(leg.venueId);
    const stakeUsd = (leg.size * leg.priceCents) / 100;
    const label = leg.label ? ` ${leg.label}` : "";
    const blockers: string[] = [];
    if (stakeUsd + 1e-9 < min) blockers.push(`${venueLabel(leg.venueId)}${label} stake $${stakeUsd.toFixed(2)} is below minimum $${min.toFixed(2)}`);
    const minContracts = venueMinContracts(leg.venueId);
    if (leg.size + 1e-9 < minContracts) blockers.push(`${venueLabel(leg.venueId)}${label} size ${leg.size.toFixed(2)} is below minimum ${minContracts.toFixed(2)} contracts`);
    return blockers;
  });
}

function venueLabel(venueId: string): string {
  if (venueId === "sxbet") return "SX.bet";
  if (venueId === "predictfun") return "Predict.fun";
  if (venueId === "polymarket") return "Polymarket";
  if (venueId === "kalshi") return "Kalshi";
  return venueId;
}

// SX.bet is the one genuinely slow/fragile leg here (on-chain settlement, real signature +
// gas latency) — it is always placed FIRST when present, so if its order fails we skip the
// hedge and never open a naked position on the other (fast, reliable) venue.
//
// Polymarket and predict.fun used to ALSO be sequenced first, on the theory that their
// FOK-or-killed orders were unreliable — but that made the OTHER leg wait on a confirmation
// round-trip before firing. That wait was fine while Polymarket fills were themselves
// unreliable (nothing to lose by waiting), but once Polymarket started filling reliably
// (single-shot placement, no book-preflight — see executor.ts's placement comment) the wait
// became pure downside: on 2026-08-08, 9 of 15 live trades went naked with the SAME
// signature — Polymarket (or predict.fun) filled, then Kalshi's IOC came back genuinely
// unfilled (a real order, a real Kalshi response, no error — the market had simply moved by
// the time Kalshi's turn came) or was skipped outright because Polymarket's fill was 95%+
// but not literally 100%. Every failure traced to the SEQUENCING delay itself, not to
// Kalshi, Polymarket, or the websocket integration (verified: every Kalshi order got a real
// order id and a real fill-or-no-fill answer from Kalshi's own API — nothing was blocked).
export function fragileVenueFirstOrder(requests: OrderRequest[]): number[] {
  const indexes = requests.map((_, i) => i);
  if (!requests.some((r) => r.venueId === "sxbet")) return indexes;
  return indexes.sort((a, b) => {
    const av = requests[a].venueId === "sxbet";
    const bv = requests[b].venueId === "sxbet";
    if (av && !bv) return -1;
    if (!av && bv) return 1;
    return a - b;
  });
}

// Sequence (SX first) ONLY when SX.bet is a leg. Every other pairing (Polymarket+Kalshi,
// Polymarket+predict.fun, Kalshi+predict.fun, ...) fires ALL legs concurrently — see the
// comment on fragileVenueFirstOrder for why sequencing those was net-negative once
// Polymarket started filling reliably.
export function shouldSequenceFragileVenuePair(requests: OrderRequest[]): boolean {
  return requests.length > 1 && requests.some((r) => r.venueId === "sxbet");
}

function skippedBecausePriorLegFailed(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}

export function commonExecutableRequests(
  requests: OrderRequest[],
  quotes: ExecutableOrderQuote[],
  depthBufferMultiple = 1
): { requests: OrderRequest[]; commonContracts: number; blockers: string[] } {
  if (requests.length === 0 || quotes.length !== requests.length) {
    return { requests, commonContracts: 0, blockers: ["executable quote count does not match order legs"] };
  }
  const blockers = quotes.flatMap((quote, i) =>
    quote.availableContracts > 0
      ? []
      : [quote.reason ?? `${venueLabel(requests[i].venueId)} has no executable depth`]
  );
  if (blockers.length) return { requests, commonContracts: 0, blockers };

  // Kalshi accepts fixed-point counts to two decimals. Use exactly the same contract
  // count on every leg so every outcome has the same guaranteed $1-per-share payout.
  const buffer = Math.max(1, depthBufferMultiple);
  const rawCommonContracts = Math.min(
    ...requests.map((r) => r.sizeContracts),
    ...quotes.map((q) => q.availableContracts / buffer)
  );
  const commonContracts = Math.floor((rawCommonContracts + 1e-9) * 100) / 100;
  if (commonContracts <= 0) return { requests, commonContracts, blockers: ["common executable size rounds to zero"] };

  return {
    commonContracts,
    blockers: [],
    requests: requests.map((request, i) => ({
      ...request,
      sizeContracts: commonContracts,
      limitPriceCents: Math.min(request.limitPriceCents, quotes[i].priceCents),
    })),
  };
}

type FillFromLevels = {
  averagePriceCents: number;
  worstPriceCents: number;
  depthAtWorstPrice: number;
};

export type ExecutableBasketOptimization = {
  requests: OrderRequest[];
  commonContracts: number;
  averagePriceCents: number[];
  totalCost: number;
  expectedProfit: number;
  netEdge: number;
  evaluatedCount: number;
  blockers: string[];
};

export type PriceCushionResult = {
  requests: OrderRequest[];
  cushionCents: number;
  worstCaseProfit: number;
  safe: boolean;
};

// Give every concurrently submitted leg the same price headroom, but only while the
// basket remains profitable if every leg fills at its worst permitted price. Sharing one
// cushion across all legs prevents us from spending the same edge twice.
export function applyEconomicPriceCushion(
  requests: OrderRequest[],
  legs: ArbLeg[],
  minExpectedProfitUsd: number,
  maxCushionCents: number,
  maxTotalCostUsd = Number.POSITIVE_INFINITY
): PriceCushionResult {
  const ceiling = Math.max(0, Math.floor(maxCushionCents));
  let fallbackProfit = Number.NEGATIVE_INFINITY;
  for (let cushionCents = ceiling; cushionCents >= 0; cushionCents--) {
    const cushioned = requests.map((request) => ({
      ...request,
      limitPriceCents: Math.min(99, request.limitPriceCents + cushionCents),
    }));
    const worstCaseLegs = legs.map((leg, i) => {
      const priceCents = cushioned[i].limitPriceCents;
      return {
        ...leg,
        size: cushioned[i].sizeContracts,
        priceCents,
        impliedProbability: priceCents / 100,
        decimalOdds: 100 / priceCents,
      };
    });
    const fees = computeFees(worstCaseLegs);
    worstCaseLegs.forEach((leg, i) => (leg.feeCents = fees[i].feeCents));
    const economics = executedEconomics(worstCaseLegs);
    fallbackProfit = economics.expectedProfit;
    if (
      economics.totalCost <= maxTotalCostUsd + 1e-9 &&
      economics.guaranteedPayout > economics.totalCost &&
      economics.expectedProfit + 1e-9 >= minExpectedProfitUsd
    ) {
      return { requests: cushioned, cushionCents, worstCaseProfit: economics.expectedProfit, safe: true };
    }
  }
  return { requests, cushionCents: 0, worstCaseProfit: fallbackProfit, safe: false };
}

// Before either venue receives an order, prove that either leg could still be bought at
// the configured emergency ceiling with enough current depth and without exceeding the
// recovery-loss budget. This cannot reserve cross-venue liquidity, but it prevents firing
// a basket that has no viable hedge path at the moment of submission.
export function recoveryPathBlockers(
  requests: OrderRequest[],
  quotes: ExecutableOrderQuote[],
  legs: ArbLeg[],
  maxSlippageCents: number,
  maxLossUsd: number
): string[] {
  if (requests.length !== 2 || quotes.length !== 2 || legs.length !== 2) {
    return ["automatic hedge recovery currently requires exactly two aligned legs"];
  }
  const blockers: string[] = [];
  for (let missingIndex = 0; missingIndex < 2; missingIndex++) {
    const filledIndex = missingIndex === 0 ? 1 : 0;
    const contracts = requests[missingIndex].sizeContracts;
    const recoveryCeiling = Math.min(99, requests[missingIndex].limitPriceCents + Math.max(0, maxSlippageCents));
    const levels = normalizedLevels(requests[missingIndex], quotes[missingIndex])
      .filter((level) => level.priceCents <= recoveryCeiling + 1e-9);
    const recoveryFill = fillFromLevels(levels, contracts);
    if (!recoveryFill) {
      blockers.push(`${venueLabel(requests[missingIndex].venueId)} lacks ${contracts.toFixed(2)} recovery contracts at <= ${recoveryCeiling.toFixed(2)}c`);
      continue;
    }
    const scenario = legs.map((leg, i) => {
      const priceCents = i === missingIndex ? recoveryCeiling : requests[filledIndex].limitPriceCents;
      return { ...leg, size: contracts, priceCents, impliedProbability: priceCents / 100, decimalOdds: 100 / priceCents };
    });
    const fees = computeFees(scenario);
    scenario.forEach((leg, i) => (leg.feeCents = fees[i].feeCents));
    const economics = executedEconomics(scenario);
    if (economics.expectedProfit < -Math.max(0, maxLossUsd) - 1e-9) {
      blockers.push(
        `${venueLabel(requests[missingIndex].venueId)} recovery could lock $${Math.abs(economics.expectedProfit).toFixed(2)} loss, above $${Math.max(0, maxLossUsd).toFixed(2)}`
      );
    }
  }
  return blockers;
}

function normalizedLevels(request: OrderRequest, quote: ExecutableOrderQuote): Array<{ priceCents: number; contracts: number }> {
  const explicit = (quote.levels ?? [])
    .filter((level) => Number.isFinite(level.priceCents) && level.priceCents > 0 && level.priceCents < 100 && Number.isFinite(level.contracts) && level.contracts > 0)
    .sort((a, b) => a.priceCents - b.priceCents);
  if (explicit.length) return explicit;
  if (quote.availableContracts > 0) {
    return [{ priceCents: quote.averagePriceCents || quote.priceCents || request.limitPriceCents, contracts: quote.availableContracts }];
  }
  return [];
}

function fillFromLevels(levels: Array<{ priceCents: number; contracts: number }>, contracts: number): FillFromLevels | null {
  let remaining = contracts;
  let costCents = 0;
  let worstPriceCents = 0;
  for (const level of levels) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, level.contracts);
    costCents += take * level.priceCents;
    worstPriceCents = level.priceCents;
    remaining -= take;
  }
  if (remaining > 1e-7 || worstPriceCents <= 0) return null;
  const depthAtWorstPrice = levels
    .filter((level) => level.priceCents <= worstPriceCents + 1e-9)
    .reduce((sum, level) => sum + level.contracts, 0);
  return { averagePriceCents: costCents / contracts, worstPriceCents, depthAtWorstPrice };
}

// Search fresh native ladders for the most profitable common-size basket. The detected size
// is a ceiling, not a requirement: the venue-minimum pass has already increased it when
// needed, and this pass can reduce every leg uniformly to any two-decimal contract count.
export function optimizeExecutableBasket(
  requests: OrderRequest[],
  quotes: ExecutableOrderQuote[],
  depthBufferMultiple: number,
  minExpectedProfitUsd: number
): ExecutableBasketOptimization {
  const empty = (blockers: string[], evaluatedCount = 0): ExecutableBasketOptimization => ({
    requests,
    commonContracts: 0,
    averagePriceCents: [],
    totalCost: 0,
    expectedProfit: 0,
    netEdge: 0,
    evaluatedCount,
    blockers,
  });
  if (!requests.length || requests.length !== quotes.length) return empty(["executable quote count does not match order legs"]);

  const ladders = requests.map((request, i) => normalizedLevels(request, quotes[i]));
  const missing = ladders.flatMap((levels, i) => levels.length ? [] : [quotes[i].reason ?? `${venueLabel(requests[i].venueId)} has no executable ask depth`]);
  if (missing.length) return empty(missing);

  const buffer = Math.max(1, depthBufferMultiple);
  const maximumContracts = Math.min(
    ...requests.map((request) => request.sizeContracts),
    ...ladders.map((levels) => levels.reduce((sum, level) => sum + level.contracts, 0) / buffer)
  );
  const maximumTicks = Math.floor((maximumContracts + 1e-9) * 100);
  if (maximumTicks < 1) return empty([`no common executable size remains after the ${buffer.toFixed(1)}x depth buffer`]);

  const strideTicks = Math.max(1, Math.ceil(maximumTicks / 50_000));
  let evaluatedCount = 0;
  let best: ExecutableBasketOptimization | null = null;
  const rejectionCounts = { depth: 0, minimum: 0, profit: 0, notArb: 0 };

  for (let ticks = maximumTicks; ticks >= 1; ticks -= strideTicks) {
    const commonContracts = ticks / 100;
    const fills = ladders.map((levels) => fillFromLevels(levels, commonContracts));
    if (fills.some((fill) => !fill)) continue;
    evaluatedCount += 1;
    const completeFills = fills as FillFromLevels[];
    if (completeFills.some((fill) => fill.depthAtWorstPrice + 1e-9 < commonContracts * buffer)) {
      rejectionCounts.depth += 1;
      continue;
    }

    const legs: ArbLeg[] = requests.map((request, i) => ({
      venueId: request.venueId,
      marketId: request.marketId,
      nativeMarketId: request.nativeMarketId,
      nativeSide: request.nativeSide,
      outcome: request.outcome as ArbLeg["outcome"],
      label: request.outcome,
      size: commonContracts,
      priceCents: completeFills[i].averagePriceCents,
      decimalOdds: 100 / completeFills[i].averagePriceCents,
      impliedProbability: completeFills[i].averagePriceCents / 100,
      feeCents: 0,
    }));
    if (legs.some((leg) => leg.size + 1e-9 < venueMinContracts(leg.venueId) || (leg.size * leg.priceCents) / 100 + 1e-9 < venueMinStakeUsd(leg.venueId))) {
      rejectionCounts.minimum += 1;
      continue;
    }
    const fees = computeFees(legs);
    legs.forEach((leg, i) => (leg.feeCents = fees[i].feeCents));
    const economics = executedEconomics(legs);
    if (economics.guaranteedPayout <= economics.totalCost) {
      rejectionCounts.notArb += 1;
      continue;
    }
    if (economics.expectedProfit + 1e-9 < minExpectedProfitUsd) {
      rejectionCounts.profit += 1;
      continue;
    }

    const candidate: ExecutableBasketOptimization = {
      requests: requests.map((request, i) => ({
        ...request,
        sizeContracts: commonContracts,
        limitPriceCents: Math.ceil(completeFills[i].worstPriceCents * 100) / 100,
      })),
      commonContracts,
      averagePriceCents: completeFills.map((fill) => fill.averagePriceCents),
      totalCost: economics.totalCost,
      expectedProfit: economics.expectedProfit,
      netEdge: economics.netEdge,
      evaluatedCount,
      blockers: [],
    };
    if (!best || candidate.expectedProfit > best.expectedProfit + 1e-9 ||
      (Math.abs(candidate.expectedProfit - best.expectedProfit) < 1e-9 && candidate.commonContracts > best.commonContracts)) {
      best = candidate;
    }
  }

  if (best) return { ...best, evaluatedCount };
  return empty([
    `no profitable resized basket after evaluating ${evaluatedCount} common sizes ` +
    `(depth ${rejectionCounts.depth}, venue minimum ${rejectionCounts.minimum}, ` +
    `profit below $${minExpectedProfitUsd.toFixed(2)} ${rejectionCounts.profit}, no-arb ${rejectionCounts.notArb})`,
  ], evaluatedCount);
}

export async function recoverMissingHedge(
  ctx: PreparedContext,
  adapters: ExecutionAdapter[],
  requests: OrderRequest[],
  results: OrderResult[]
): Promise<{ results: OrderResult[]; reconciliations: LegReconciliation[]; step: ExecutionStep | null }> {
  if (results.length !== 2 || requests.length !== 2 || adapters.length !== 2 || results.some((result) => result.status === "pending")) {
    return { results, reconciliations: [], step: null };
  }
  const working = results.map((result) => ({ ...result }));
  const largerIndex = working[0].filledContracts >= working[1].filledContracts ? 0 : 1;
  const missingIndex = largerIndex === 0 ? 1 : 0;
  // Match what the venue actually filled, including price-improvement shares above the
  // requested minimum. Capping this at the request hid real residual exposure.
  const targetContracts = working[largerIndex].filledContracts;
  if (targetContracts <= 0 || targetContracts - working[missingIndex].filledContracts <= 1e-9) {
    return { results, reconciliations: [], step: null };
  }

  const maxSlippage = Math.max(0, ctx.risk.hedgeRecoveryMaxSlippageCents ?? 10);
  const maxLoss = Math.max(0, ctx.risk.hedgeRecoveryMaxLossUsd ?? 1);
  const maxPriceCents = Math.min(99, requests[missingIndex].limitPriceCents + maxSlippage);
  const attempts = 3;
  let lastReason = "no executable recovery quote";
  const originalOrderId = results[missingIndex].orderId;
  const reconciliations: LegReconciliation[] = [];
  const recoveryOrderIds: string[] = [];
  let lastModeledProfit = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const missingContracts = Math.max(0, targetContracts - working[missingIndex].filledContracts);
    if (missingContracts <= 1e-9) break;
    const recoveryRequest: OrderRequest = {
      ...requests[missingIndex],
      sizeContracts: missingContracts,
      limitPriceCents: maxPriceCents,
    };
    if (
      missingContracts + 1e-9 < venueMinContracts(recoveryRequest.venueId) ||
      (missingContracts * maxPriceCents) / 100 + 1e-9 < venueMinStakeUsd(recoveryRequest.venueId)
    ) {
      lastReason = `remaining ${missingContracts.toFixed(2)}-contract imbalance is below ${venueLabel(recoveryRequest.venueId)}'s minimum recovery order`;
      break;
    }
    const quote = adapters[missingIndex].quoteOrder ? await adapters[missingIndex].quoteOrder(recoveryRequest) : null;
    if (!quote || quote.availableContracts + 1e-9 < missingContracts || quote.priceCents > maxPriceCents) {
      lastReason = quote?.reason ?? `only ${quote?.availableContracts ?? 0} of ${missingContracts.toFixed(2)} recovery contracts available`;
      continue;
    }
    // Keep the full emergency ceiling on the submitted order. Narrowing this to the
    // just-observed ask recreates the quote/place race: a 25c quote followed by a 27c ask
    // was rejected even though the approved recovery ceiling was 32c.
    const existingMissing = working[missingIndex].filledContracts;
    const combinedMissingPrice = (
      existingMissing * working[missingIndex].avgPriceCents + missingContracts * maxPriceCents
    ) / targetContracts;
    const modeledLegs = ctx.executedLegs.map((leg, i) => {
      const priceCents = i === missingIndex ? combinedMissingPrice : working[i].avgPriceCents;
      return { ...leg, size: targetContracts, priceCents, impliedProbability: priceCents / 100, decimalOdds: 100 / priceCents };
    });
    const modeledFees = computeFees(modeledLegs);
    modeledLegs.forEach((leg, i) => (leg.feeCents = modeledFees[i].feeCents));
    const modeledEconomics = executedEconomics(modeledLegs);
    lastModeledProfit = modeledEconomics.expectedProfit;
    if (modeledEconomics.expectedProfit < -maxLoss) {
      lastReason = `recovery would lock $${Math.abs(modeledEconomics.expectedProfit).toFixed(2)} loss, above $${maxLoss.toFixed(2)} ceiling`;
      break;
    }

    const placed = await adapters[missingIndex].placeOrder(recoveryRequest);
    const recoveryRecon = await reconcileLegs([adapters[missingIndex]], [recoveryRequest], [placed]);
    reconciliations.push(...recoveryRecon);
    const confirmed = applyReconciliation([placed], recoveryRecon, [recoveryRequest])[0];
    if (confirmed.orderId) recoveryOrderIds.push(confirmed.orderId);
    if (confirmed.filledContracts > 0) {
      const priorContracts = working[missingIndex].filledContracts;
      const addedContracts = Math.min(missingContracts, confirmed.filledContracts);
      const combinedContracts = priorContracts + addedContracts;
      const combinedPrice = combinedContracts > 0
        ? (priorContracts * working[missingIndex].avgPriceCents + addedContracts * confirmed.avgPriceCents) / combinedContracts
        : confirmed.avgPriceCents;
      working[missingIndex] = {
        ...confirmed,
        ok: true,
        filledContracts: combinedContracts,
        avgPriceCents: combinedPrice,
        status: combinedContracts + 1e-9 >= requests[missingIndex].sizeContracts ? "filled" : "partial",
      };
    }
    if (working[missingIndex].filledContracts + 1e-9 >= targetContracts) {
      requests[missingIndex] = { ...requests[missingIndex], limitPriceCents: recoveryRequest.limitPriceCents };
      return {
        results: working,
        reconciliations,
        step: {
          key: "hedge_recovery",
          label: "Automatic hedge recovery",
          status: "pass",
          detail: `${venueLabel(requests[missingIndex].venueId)} recovered the basket to ${targetContracts.toFixed(2)} matched contracts at <= ${recoveryRequest.limitPriceCents.toFixed(2)}c; projected worst-case basket P&L $${modeledEconomics.expectedProfit.toFixed(2)} (original order ${originalOrderId ?? "none"}; recovery orders ${recoveryOrderIds.join(", ") || "none"})`,
        },
      };
    }
    lastReason = confirmed.status === "pending" ? "recovery order confirmation still pending" : confirmed.error ?? "recovery IOC/FOK did not fill";
    if (confirmed.status === "pending") {
      working[missingIndex] = {
        ...confirmed,
        filledContracts: working[missingIndex].filledContracts,
        avgPriceCents: working[missingIndex].avgPriceCents,
        status: "pending",
      };
      return {
        results: working,
        reconciliations,
        step: {
          key: "hedge_recovery",
          label: "Automatic hedge recovery",
          status: "warn",
          detail: `${venueLabel(requests[missingIndex].venueId)} accepted the recovery order; fill confirmation is pending, so no duplicate retry was sent`,
        },
      };
    }
    // A venue acknowledgement/hash could still represent a live order. Only retry when
    // placement produced no identifier at all, or reconciliation explicitly proved the
    // order terminal with zero fill.
    const confirmationStatus = recoveryRecon[0]?.confirmation?.status;
    const explicitlyTerminal = confirmationStatus === "failed" || confirmationStatus === "settled";
    const adapterIsImmediate = !adapters[missingIndex].confirmFill;
    if (confirmed.orderId || confirmed.confirmationId) {
      if (!explicitlyTerminal && !adapterIsImmediate) break;
    }
  }

  return {
    results: working,
    reconciliations,
    step: {
      key: "hedge_recovery",
      label: "Automatic hedge recovery",
      status: "halt",
      detail: `Could not fully match ${targetContracts.toFixed(2)} contracts on ${venueLabel(requests[missingIndex].venueId)} within +${maxSlippage.toFixed(2)}c / $${maxLoss.toFixed(2)} max loss (last projected P&L $${lastModeledProfit.toFixed(2)}): ${lastReason}`,
    },
  };
}

type RunResult = ExecutionOutcome & { mode: ExecMode; blockers: string[] };
const executionQueue = globalThis as typeof globalThis & { __arbLiveExecutionTail?: Promise<void> };

function serializeLiveExecution<T>(work: () => Promise<T>): Promise<T> {
  const tail = executionQueue.__arbLiveExecutionTail ?? Promise.resolve();
  const run = tail.then(work, work);
  executionQueue.__arbLiveExecutionTail = run.then(() => undefined, () => undefined);
  return run;
}

export function runExecution(
  opportunityId: string,
  date: string,
  requestedMode: ExecMode,
  creds?: ExecCreds,
  // ISO timestamp of when the underlying opportunity was originally detected (arbEngine.ts's
  // detectArbs) — NOT when this execution attempt started. Threaded through from
  // scannerWorker.ts's auto-fire so a saved trade can show true end-to-end "detected to
  // filled" latency (trade.openedAt - trade.detectedAt), not just this attempt's own timing.
  // Omitted for manually-triggered trades (the Play button), where there's no single
  // detection instant to anchor to.
  detectedAt?: string
): Promise<RunResult> {
  // One live basket at a time per server process. This ensures the completed trade is saved
  // before the next queued request checks the Risk panel's per-match open-position limit.
  // Paper simulations remain concurrent.
  return requestedMode === "live"
    ? serializeLiveExecution(() => runExecutionUnlocked(opportunityId, date, requestedMode, creds, detectedAt))
    : runExecutionUnlocked(opportunityId, date, requestedMode, creds, detectedAt);
}

async function runExecutionUnlocked(
  opportunityId: string,
  date: string,
  requestedMode: ExecMode,
  creds?: ExecCreds,
  detectedAt?: string
): Promise<RunResult> {
  const pipelineStartMs = Date.now();
  const prep = await prepareExecution(opportunityId, date, requestedMode, pipelineStartMs);
  if (prep.kind === "halt") return { ...prep.outcome, mode: "dry_run", blockers: [] };
  const ctx = prep.ctx;

  // ── Resolve the execution decision through the hard gate ────────────────────
  const gate = resolveExecutionMode({
    requestedMode,
    agentPaper: ctx.agent.paper,
    agentLive: ctx.agent.live,
    venues: ctx.venues,
    stakeUsd: ctx.totalStake,
    // Venue minimum sizing must never override the live risk cap. If the valid common
    // basket is too large, skip it instead of silently increasing real-money exposure.
    maxLiveStakeUsd: ctx.risk.maxLiveStakeUsd,
    venuesSupportLive: venueSupportsLive(ctx.venues, creds),
  });

  // A LIVE request that can't fire FAILS loudly with its reasons — it is NOT downgraded to
  // a paper trade. (Paper trades only happen when the caller explicitly chose paper mode.)
  if (gate.blocked) {
    const reason = `Live execution blocked — ${gate.blockers.join("; ")}`;
    await writeLog(
      ctx.agent,
      ctx.opportunityMatchup,
      ctx.venues,
      ctx.netAfter,
        "halted",
        "live_blocked",
        reason,
        {
          effectiveMode: "blocked",
          gateBlockers: gate.blockers,
          opportunityId: ctx.opportunityId,
          pipelineSteps: [
            ...ctx.executionSteps,
            { key: "exec_mode", label: "Execution mode", status: "halt", detail: "Live request blocked before order placement", tookMs: Date.now() - pipelineStartMs },
          ],
          totalCost: ctx.totalStake,
          expectedProfit: ctx.expectedProfit,
        },
      date,
      "live"
    );
    return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: gate.blockers };
  }
  const mode = gate.mode;
  const executionSteps = [...ctx.executionSteps];
  // Same pipelineStartMs clock prepareExecution's own steps were stamped against, so the
  // saved trade's executionSteps show one continuous timeline from attempt start through
  // placement/reconciliation, not two timelines that each reset to 0.
  const pushStep = (step: ExecutionStep) => executionSteps.push({ ...step, tookMs: Date.now() - pipelineStartMs });
  pushStep({
    key: "exec_mode",
    label: "Execution mode",
    status: mode === "live" ? "warn" : "pass",
    detail: mode === "live" ? "Live adapters armed" : "Dry-run paper adapter selected",
  });

  if (mode === "live") {
    const minStakeBlockers = liveVenueMinimumStakeBlockers(ctx.executedLegs);
    if (minStakeBlockers.length) {
      const reason = `Live execution blocked - ${minStakeBlockers.join("; ")}`;
      await writeLog(
        ctx.agent,
        ctx.opportunityMatchup,
        ctx.venues,
        ctx.netAfter,
        "halted",
        "live_blocked",
        reason,
        { effectiveMode: "blocked", gateBlockers: minStakeBlockers, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps },
        date,
        "live"
      );
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: minStakeBlockers };
    }
  }

  // ── Place ALL legs concurrently ─────────────────────────────────────────────
  // A cross-venue arb must fire both legs at once: placing them sequentially leaves a
  // window where leg A is filled and leg B's price has moved, creating naked exposure.
  const adapters: ExecutionAdapter[] = ctx.executedLegs.map((leg) => getAdapter(leg.venueId, mode, creds));
  let requests: OrderRequest[] = ctx.executedLegs.map((leg) => ({
    venueId: leg.venueId,
    marketId: leg.marketId,
    nativeMarketId: leg.nativeMarketId,
    nativeSide: leg.nativeSide,
    outcome: leg.outcome,
    sizeContracts: leg.size,
    limitPriceCents: leg.priceCents,
  }));

  if (mode === "live") {
    // Fast, in-memory pre-check against the already-connected live-book websocket caches
    // (polymarketLiveBook / kalshiLiveBook) — zero network cost, unlike the REST-based
    // "executable books" quote below. Two jobs: (1) nudge a leg's limit up to match a live
    // ask that ticked against us within a small cushion, so the REST quote right after this
    // gets a fair shot at the CURRENT price instead of a stale detection-time one; (2) abort
    // the whole trade before spending time on that REST round-trip at all if the live book
    // already shows the price moved past the cushion or there isn't enough size resting —
    // the REST preflight's own latency is exactly what let the book move further and kill
    // fills before (see the removed single-venue "anchor preflight" this superseded).
    const liveCheck = checkLiveFillability(requests, {
      askCents: liveAskCentsFor,
      depthAtOrBetter: liveDepthAtOrBetter,
    });
    requests = liveCheck.requests;
    for (const adj of liveCheck.adjustments) {
      pushStep({
        key: `live_price_${adj.venueId}`,
        label: `${venueLabel(adj.venueId)} live price check`,
        status: "warn",
        detail: `Live ask moved to ${adj.toCents}c — bumped limit from ${adj.fromCents}c to match (in-memory, no added latency)`,
      });
    }
    if (liveCheck.blockers.length) {
      const reason = `Live execution blocked - ${liveCheck.blockers.join("; ")}`;
      await writeLog(
        ctx.agent,
        ctx.opportunityMatchup,
        ctx.venues,
        ctx.netAfter,
        "halted",
        "live_blocked",
        reason,
        { effectiveMode: "blocked", gateBlockers: liveCheck.blockers, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps },
        date,
        "live"
      );
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: liveCheck.blockers };
    }

    // Fetch every native ask ladder concurrently with a permissive probe ceiling. The
    // optimizer, not a fixed cents cushion, establishes the actual price ceiling by testing
    // every common size against fresh depth, exact fees, $1.01 venue floors, and profit.
    const depthBuffer = Math.max(1, ctx.risk.liquidityStakeBufferMultiple);
    const requestedContracts = Math.min(...requests.map((request) => request.sizeContracts));
    const depthProbeRequests = requests.map((request) => ({
      ...request,
      sizeContracts: request.sizeContracts * depthBuffer,
      limitPriceCents: 99,
    }));
    // If EVERY leg is Polymarket/Kalshi (the venues with a live-book websocket) and each
    // one's live ladder alone already covers the full buffered probe size, skip the REST
    // quote-probe round trip entirely — this is the same latency source that used to kill
    // Polymarket fills when probed via REST right before firing (see the removed
    // single-venue "anchor preflight" referenced elsewhere in this file), just now avoided
    // instead of merely made faster. Any leg without enough live depth (or on a venue with
    // no live book — SX.bet, predict.fun, Cloudbet) falls the WHOLE basket back to the
    // existing REST probe for every leg, unchanged from before.
    const liveOnly = buildLiveOnlyQuotes(depthProbeRequests, (request) =>
      request.venueId === "polymarket" && request.nativeSide
        ? polymarketLiveBook.getAskLevels(request.nativeSide)
        : request.venueId === "kalshi" && request.nativeMarketId && request.nativeSide
          ? kalshiLiveBook.getAskLevels(request.nativeMarketId, request.nativeSide.toLowerCase() === "no" ? "no" : "yes")
          : null
    );
    const canSkipQuoteProbe = liveOnly.canSkipRestProbe;
    const nativeQuotes = canSkipQuoteProbe
      ? (liveOnly.quotes as ExecutableOrderQuote[])
      : await Promise.all(
          adapters.map((adapter, i): Promise<ExecutableOrderQuote> => adapter.quoteOrder
            ? adapter.quoteOrder(depthProbeRequests[i])
            : Promise.resolve({
                ok: true,
                priceCents: requests[i].limitPriceCents,
                averagePriceCents: requests[i].limitPriceCents,
                availableContracts: depthProbeRequests[i].sizeContracts,
                levels: [{ priceCents: requests[i].limitPriceCents, contracts: depthProbeRequests[i].sizeContracts }],
              }))
        );
    if (canSkipQuoteProbe) {
      pushStep({
        key: "live_quote_probe",
        label: "Quote probe",
        status: "pass",
        detail: "Skipped the REST depth probe — live-book ladders on every leg already covered the required size (in-memory, no added latency)",
      });
    }
    const quotes = nativeQuotes.map((quote, i) => {
      const request = requests[i];
      if (request.venueId !== "kalshi" || !request.nativeMarketId || !request.nativeSide) return quote;
      const side = request.nativeSide.toLowerCase() === "no" ? "no" : "yes";
      const liveLevels = kalshiLiveBook.getAskLevels(request.nativeMarketId, side);
      // The REST market snapshot is the freshest independent top-price confirmation. Only
      // trust websocket depth beyond that top when both sources identify the same best ask.
      if (!liveLevels?.length || Math.abs(liveLevels[0].priceCents - quote.priceCents) > 1e-9) return quote;
      return {
        ...quote,
        levels: liveLevels,
        availableContracts: liveLevels.reduce((sum, level) => sum + level.contracts, 0),
      };
    });
    const optimized = optimizeExecutableBasket(requests, quotes, depthBuffer, ctx.risk.minExpectedProfitUsd);
    if (optimized.blockers.length) {
      const reason = `Live execution blocked - ${optimized.blockers.join("; ")}`;
      await writeLog(
        ctx.agent,
        ctx.opportunityMatchup,
        ctx.venues,
        ctx.netAfter,
        "halted",
        "live_blocked",
        reason,
        { effectiveMode: "blocked", gateBlockers: optimized.blockers, executableQuotes: quotes, evaluatedSizes: optimized.evaluatedCount, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps },
        date,
        "live"
      );
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: optimized.blockers };
    }

    requests = optimized.requests;
    const executableLimits = requests.map((request) => request.limitPriceCents);
    const quotedLegs = ctx.executedLegs.map((leg, i) => ({
      ...leg,
      size: optimized.commonContracts,
      priceCents: optimized.averagePriceCents[i],
    }));
    const minimumBlockers = liveVenueMinimumStakeBlockers(quotedLegs);
    const quotedFees = computeFees(quotedLegs);
    quotedLegs.forEach((leg, i) => (leg.feeCents = quotedFees[i].feeCents));
    const quotedEconomics = executedEconomics(quotedLegs);
    const economicBlockers = [
      ...minimumBlockers,
      ...(quotedEconomics.expectedProfit < ctx.risk.minExpectedProfitUsd
        ? [`executable profit $${quotedEconomics.expectedProfit.toFixed(2)} is below $${ctx.risk.minExpectedProfitUsd.toFixed(2)}`]
        : []),
      ...(quotedEconomics.guaranteedPayout <= quotedEconomics.totalCost
        ? ["live executable prices no longer form an arbitrage"]
        : []),
    ];
    if (economicBlockers.length) {
      const reason = `Live execution blocked - ${economicBlockers.join("; ")}`;
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, quotedEconomics.netEdge, "halted", "live_blocked", reason, {
        effectiveMode: "blocked",
        gateBlockers: economicBlockers,
        executableQuotes: quotes,
        commonContracts: optimized.commonContracts,
        submittedStakesUsd: quotedLegs.map((leg) => Number(((leg.size * leg.priceCents) / 100).toFixed(4))),
        totalCost: quotedEconomics.totalCost,
        expectedProfit: quotedEconomics.expectedProfit,
        pipelineSteps: executionSteps,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: economicBlockers };
    }
    const cushion = applyEconomicPriceCushion(
      requests,
      quotedLegs,
      ctx.risk.minExpectedProfitUsd,
      ctx.risk.hedgeRecoveryMaxSlippageCents ?? 10,
      ctx.risk.maxLiveStakeUsd
    );
    requests = cushion.requests;
    pushStep({
      key: "executable_books",
      label: "Optimized executable basket",
      status: "pass",
      detail: `${requestedContracts.toFixed(2)} requested -> ${optimized.commonContracts.toFixed(2)} exact common contracts; fresh ladder limits ${optimized.requests.map((request) => `${venueLabel(request.venueId)} ${request.limitPriceCents.toFixed(2)}c`).join(" / ")}; ${depthBuffer.toFixed(1)}x depth; $${quotedEconomics.expectedProfit.toFixed(2)} executable profit after evaluating ${optimized.evaluatedCount} sizes`,
    });
    pushStep({
      key: "price_cushion",
      label: "Economics-safe submission ceilings",
      status: cushion.safe ? (cushion.cushionCents > 0 ? "pass" : "info") : "halt",
      detail: `${cushion.cushionCents.toFixed(0)}c shared movement allowance; observed limits ${executableLimits.map((limit, i) => `${venueLabel(requests[i].venueId)} ${limit.toFixed(2)}c`).join(" / ")}; submission ceilings ${requests.map((request) => `${venueLabel(request.venueId)} ${request.limitPriceCents.toFixed(2)}c`).join(" / ")}; worst-case profit $${cushion.worstCaseProfit.toFixed(2)}`,
    });
    if (!cushion.safe) {
      const blockers = [`worst-case submission profit $${cushion.worstCaseProfit.toFixed(2)} is below $${ctx.risk.minExpectedProfitUsd.toFixed(2)}`];
      const reason = `Live execution blocked - ${blockers[0]}`;
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, quotedEconomics.netEdge, "halted", "live_blocked", reason, {
        effectiveMode: "blocked",
        gateBlockers: blockers,
        totalCost: quotedEconomics.totalCost,
        expectedProfit: quotedEconomics.expectedProfit,
        pipelineSteps: executionSteps,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers };
    }

    const recoveryBlockers = recoveryPathBlockers(
      requests,
      quotes,
      quotedLegs,
      ctx.risk.hedgeRecoveryMaxSlippageCents ?? 10,
      ctx.risk.hedgeRecoveryMaxLossUsd ?? 1
    );
    pushStep({
      key: "recovery_preflight",
      label: "Emergency hedge path",
      status: recoveryBlockers.length ? "halt" : "pass",
      detail: recoveryBlockers.length
        ? recoveryBlockers.join("; ")
        : `Both one-leg failure scenarios have current depth within the configured recovery price/loss ceilings`,
    });
    if (recoveryBlockers.length) {
      const reason = `Live execution blocked - ${recoveryBlockers.join("; ")}`;
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, quotedEconomics.netEdge, "halted", "live_blocked", reason, {
        effectiveMode: "blocked",
        gateBlockers: recoveryBlockers,
        totalCost: quotedEconomics.totalCost,
        expectedProfit: quotedEconomics.expectedProfit,
        pipelineSteps: executionSteps,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: recoveryBlockers };
    }
  }

  let placed: OrderResult[];
  const sequencingOrder = mode === "live" ? fragileVenueFirstOrder(requests) : requests.map((_, i) => i);
  const shouldSequence = mode === "live" && shouldSequenceFragileVenuePair(requests);

  if (shouldSequence) {
    placed = new Array<OrderResult>(requests.length);
    const [first, ...rest] = sequencingOrder;
    placed[first] = await adapters[first].placeOrder(requests[first]);
    if (!placed[first].ok || placed[first].filledContracts < requests[first].sizeContracts) {
      const firstVenue = venueLabel(requests[first].venueId);
      const error = `not submitted because ${firstVenue} anchor leg did not fully fill: ${placed[first].error ?? placed[first].status}`;
      for (const i of rest) placed[i] = skippedBecausePriorLegFailed(requests[i], error);
    } else {
      const restResults = await Promise.all(rest.map((i) => adapters[i].placeOrder(requests[i])));
      rest.forEach((i, idx) => {
        placed[i] = restResults[idx];
      });
    }
  } else {
    placed = await Promise.all(adapters.map((a, i) => a.placeOrder(requests[i])));
  }

  // ── Reconcile settlement (live only) ────────────────────────────────────────
  // Re-query venues to confirm the orders actually settled (on-chain venues ack before
  // finality). Folds an explicit settlement failure back into the fill counts so a
  // half-settled arb is correctly flagged naked instead of falsely reported filled.
  let reconciliation: LegReconciliation[] = [];
  let results = placed;
  if (mode === "live") {
    reconciliation = await reconcileLegs(adapters, requests, placed);
    results = applyReconciliation(placed, reconciliation, requests);
    const recovery = await recoverMissingHedge(ctx, adapters, requests, results);
    results = recovery.results;
    reconciliation.push(...recovery.reconciliations);
    if (recovery.step) pushStep(recovery.step);
  }

  // ── Derive position status from per-leg fills ───────────────────────────────
  const filledFlags = results.map((r) => r.filledContracts > 0);
  const minFilledContracts = Math.min(...results.map((r) => r.filledContracts));
  const maxFilledContracts = Math.max(...results.map((r) => r.filledContracts));
  const fillImbalanceContracts = maxFilledContracts - minFilledContracts;
  const balanced = fillImbalanceContracts <= 0.01 + 1e-9;
  const fullyFilled = balanced && results.every((r, i) => r.filledContracts + 1e-9 >= requests[i].sizeContracts);
  const anyFilled = filledFlags.some(Boolean);
  const allFilled = filledFlags.every(Boolean);
  const anyPending = results.some((r) => r.status === "pending");

  let status: Trade["status"];
  let fillStatus: Trade["fillStatus"];
  let result: ExecutionOutcome["result"];
  let reasonCode: ExecutionOutcome["reasonCode"] = null;
  let reason: string;
  let nakedLegIndex: number | undefined;

  if (allFilled && fullyFilled) {
    status = "open";
    fillStatus = "filled";
    result = "executed";
    reason = mode === "live" ? "Both legs filled (live)" : "Both legs filled (dry-run)";
  } else if (anyPending) {
    status = "partial";
    fillStatus = "partial";
    result = "partial";
    reason = "Venue accepted an order, but final fill confirmation is still pending";
  } else if (allFilled && balanced) {
    status = "partial";
    fillStatus = "partial";
    result = "partial";
    reason = "Partial fill — reduced size";
  } else if (allFilled && fillImbalanceContracts < 0.1) {
    status = "partial";
    fillStatus = "partial";
    result = "partial";
    reason = `Both legs filled with a ${fillImbalanceContracts.toFixed(4)}-contract residual below venue minimum order size`;
  } else if (anyFilled) {
    status = "naked";
    fillStatus = "partial";
    result = "naked";
    reasonCode = "naked_position";
    reason = "One leg filled, the hedge did not — unhedged exposure";
    reason = allFilled
      ? `Leg fills remain imbalanced by ${fillImbalanceContracts.toFixed(2)} contracts - unhedged exposure`
      : reason;
    nakedLegIndex = results.findIndex((r) => r.filledContracts === maxFilledContracts);
  } else {
    // Nothing filled — treat as a hedge failure with no exposure.
    status = "failed";
    fillStatus = "failed";
    result = "halted";
    reasonCode = "hedge_failed";
    reason = results.find((r) => r.error)?.error ?? "No legs filled";
  }
  pushStep({
    key: "execute",
    label: "Leg execution",
    status: result === "executed" ? "pass" : result === "partial" ? "warn" : "halt",
    detail: reason,
  });

  // Reflect actual executed prices/sizes on the legs.
  const legs: ArbLeg[] = ctx.executedLegs.map((l, i) => {
    const r = results[i];
    const cents = r.avgPriceCents || l.priceCents;
    return { ...l, priceCents: cents, decimalOdds: 100 / cents, impliedProbability: cents / 100, size: r.filledContracts };
  });

  // Recompute economics from what ACTUALLY filled (real avg prices + filled sizes) so the
  // portfolio shows the truth of the fill, not the pre-trade quote. Fees are re-derived on
  // the actual sizes; cost/profit/edge come from the shared executed-economics helper.
  const legFees = computeFees(legs);
  legs.forEach((l, i) => (l.feeCents = legFees[i].feeCents));
  const econ = executedEconomics(legs);

  const opened = new Date().toISOString();
  const tradeMode = mode === "live" ? "live" : "paper";
  const trade: Trade | null =
    status === "failed"
      ? null
      : {
          id: `trade-${ctx.opportunityId}-${Date.now()}`,
          mode: tradeMode,
          opportunityId: ctx.opportunityId,
          agentId: ctx.agent.id,
          matchup: ctx.opportunityMatchup,
          legs,
          orderIds: results.map((r) => r.orderId),
          fillStatus,
          totalCost: econ.totalCost,
          expectedProfit: econ.expectedProfit,
          realizedPnl: null,
          netEdge: econ.netEdge,
          clvDrift: null,
          status,
          openedAt: opened,
          closedAt: null,
          date,
          nakedLegIndex,
          executionSteps,
          detectedAt,
        };

  const postFill = trade ? await verifyPostFill(ctx.opportunityId, date, ctx.netAfter) : undefined;
  if (trade) {
    trade.postFill = postFill;
    trade.executionSteps = [
      ...executionSteps,
      {
        key: "post_fill",
        label: "Post-fill verification",
        status: postFill?.status === "edge_intact" ? "warn" : postFill?.status === "arb_gone" ? "pass" : "info",
        detail: postFill?.reason,
        tookMs: Date.now() - pipelineStartMs,
      },
    ];
    await saveTrade(trade);
  }
  await writeLog(
    ctx.agent,
    ctx.opportunityMatchup,
    ctx.venues,
    trade ? econ.netEdge : ctx.netAfter,
    result === "halted" ? "halted" : result,
    reasonCode,
    reason,
    {
      effectiveMode: mode,
      gateBlockers: gate.blockers,
      tradeId: trade?.id ?? null,
      opportunityId: ctx.opportunityId,
      pipelineSteps: trade?.executionSteps ?? executionSteps,
      orders: results.map((r, i) => ({
        venue: ctx.executedLegs[i].venueId,
        orderId: r.orderId,
        confirmationId: r.confirmationId,
        status: r.status,
        filled: r.filledContracts,
        error: r.error,
      })),
      reconciliation: reconciliation.length
        ? reconciliation.map((rc) => ({ venue: rc.venue, orderId: rc.orderId, settlement: rc.confirmation?.status ?? "n/a" }))
        : undefined,
      totalCost: econ.totalCost,
      expectedProfit: econ.expectedProfit,
      postFill,
    },
    date,
    tradeMode
  );

  return { result, reasonCode, reason, trade, mode, blockers: gate.blockers };
}
