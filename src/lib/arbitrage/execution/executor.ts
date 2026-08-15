// The real executor. Runs the shared pre-execution checks, resolves the effective
// mode through the safety gate (defaults to dry-run unless EVERY live switch is on),
// then places each leg through its venue adapter and records the Trade + log. Dry-run
// and live share this exact path — only the adapter differs.

import { createHash, randomUUID } from "node:crypto";
import type { ArbLeg, ArbOpportunity, ExecutionStep, ExecutionTiming, Trade } from "@/types/arbitrage";
import { getAllTrades, saveTrade } from "../tradeStore";
import { opportunityMatchKey, prepareExecution, verifyPostFill, writeLog, type ExecutionOutcome, type PreparedContext } from "../executionPipeline";
import { resolveExecutionMode, SXBET_MIN_TAKER_STAKE_USD, type ExecMode } from "./config";
import { getAdapter, venueSupportsLive, type ExecCreds } from "./registry";
import { applyReconciliation, reconcileLegs, type LegReconciliation } from "./reconcile";
import { computeFees } from "../feeEngine";
import { executedEconomics, guaranteedTradeEconomics, venueMinContracts, venueMinStakeUsd } from "../arbMath";
import { polymarketLiveBook } from "../polymarketLiveBook";
import { kalshiLiveBook } from "../kalshiLiveBook";
import type { ExecutableOrderQuote, ExecutionAdapter, OrderRequest, OrderResult } from "./types";
import { getRiskReservationService, type RiskReservation, type RiskReservationService } from "./riskReservation";
import { clearVenueFailure, recordVenueFailure, venueCircuitBlocker } from "./venueCircuitBreaker";
import { fillAskLevels, normalizeAskLevels } from "../executableBook";
import { polymarketV3BuyAmountCandidates, polymarketV3BuyAmounts, type PolymarketV3BuyAmounts } from "./polymarketAmounts";

const POLYMARKET_ANCHOR_CONFIRM_POLL_MS = 500;
const POLYMARKET_ANCHOR_CONFIRM_ATTEMPTS = 5;

// Live-book reads for checkLiveFillability, keyed off the real singletons (ingest.ts keeps
// both connected + subscribed to today's markets). A thin adapter over each venue's own
// key shape — see LiveBookReader's doc comment for why the two venues are keyed differently.
function liveAskCentsFor(req: OrderRequest): number | null {
  if (req.venueId === "polymarket" && req.nativeSide) {
    const levels = polymarketLiveBook.getAskLevels(req.nativeSide);
    return levels ? fillAskLevels(levels, Math.max(1, venueMinContracts(req.venueId)))?.worstPriceCents ?? null : null;
  }
  if (req.venueId === "kalshi" && req.nativeMarketId && req.nativeSide) {
    const levels = kalshiLiveBook.getAskLevels(req.nativeMarketId, req.nativeSide.toLowerCase() === "no" ? "no" : "yes");
    return levels ? fillAskLevels(levels, Math.max(1, venueMinContracts(req.venueId)))?.worstPriceCents ?? null : null;
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

function preparedSnapshotLevels(ctx: PreparedContext, req: OrderRequest): Array<{ priceCents: number; contracts: number }> | null {
  const leg = ctx.liveExecutionSnapshot?.legs.find((candidate) => candidate.marketId === req.marketId);
  return leg ? leg.levels.map((level) => ({ ...level })) : null;
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
export const NATIVE_QUOTE_TIMEOUT_MS = 2_000;
const CONTRACT_BALANCE_TOLERANCE = 0.01;

async function boundedNativeQuote(
  promise: Promise<ExecutableOrderQuote>,
  venueId: string,
  timeoutMs = NATIVE_QUOTE_TIMEOUT_MS
): Promise<ExecutableOrderQuote> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<ExecutableOrderQuote>((resolve) => {
        timer = setTimeout(() => resolve({
          ok: false,
          priceCents: 0,
          averagePriceCents: 0,
          availableContracts: 0,
          reason: `${venueLabel(venueId)} exact-leg quote timed out after ${timeoutMs}ms`,
        }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    const fill = fillAskLevels(levels, request.sizeContracts);
    if (!fill) return null;
    return {
      ok: true,
      priceCents: fill.worstPriceCents,
      averagePriceCents: fill.averagePriceCents,
      availableContracts: fill.availableContracts,
      levels: fill.levels,
    };
  });
  return { quotes, canSkipRestProbe: quotes.every((q) => q != null) };
}

// Re-exported for callers/tests that reference it from the executor module.
export { SXBET_MIN_TAKER_STAKE_USD };

// Final safety-net check right before placement: every leg must clear its venue's dollar
// and/or contract minimum at its EXECUTED size. executionPipeline.ts's
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

// SX.bet leads when present because it is the slow/fragile on-chain leg. For an exact
// Polymarket/Kalshi pair, Polymarket is an unconditional anchor: Kalshi is not submitted
// until Polymarket reports a complete FOK fill. Kalshi's IOC is then the fast hedge and gets
// the basket's economics-safe movement allowance (see applyVenueAwarePriceCushion).
export function fragileVenueFirstOrder(requests: OrderRequest[]): number[] {
  const indexes = requests.map((_, i) => i);
  const priorityVenue = requests.some((r) => r.venueId === "sxbet")
    ? "sxbet"
    : requests.some((r) => r.venueId === "polymarket") && requests.some((r) => r.venueId === "kalshi")
      ? "polymarket"
      : null;
  if (!priorityVenue) return indexes;
  return indexes.sort((a, b) => {
    const av = requests[a].venueId === priorityVenue;
    const bv = requests[b].venueId === priorityVenue;
    if (av && !bv) return -1;
    if (!av && bv) return 1;
    return a - b;
  });
}

// Every other pairing (Polymarket+predict.fun, Kalshi+predict.fun, ...) still fires all legs
// concurrently. predict.fun is not an anchor because its fill confirmation can require a
// long poll loop.
export function shouldSequenceFragileVenuePair(requests: OrderRequest[]): boolean {
  if (requests.length <= 1) return false;
  if (requests.some((r) => r.venueId === "sxbet")) return true;
  return requests.some((r) => r.venueId === "polymarket") && requests.some((r) => r.venueId === "kalshi");
}

export function isPolymarketKalshiPair(requests: OrderRequest[]): boolean {
  return requests.length === 2 &&
    requests.some((request) => request.venueId === "polymarket") &&
    requests.some((request) => request.venueId === "kalshi");
}

function skippedBecausePriorLegFailed(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}

// A Polymarket FOK can acknowledge as `delayed` before its matched trade is indexed. Do not
// interpret that temporary zero as a failed anchor: confirm the original order id first, at
// 500ms intervals, so Kalshi is dispatched as soon as the actual exposure becomes visible.
export async function confirmPendingAnchor(
  adapter: ExecutionAdapter,
  request: OrderRequest,
  result: OrderResult,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<{ result: OrderResult; reconciliation: LegReconciliation }> {
  if (result.status !== "pending" || !(result.confirmationId ?? result.orderId) || !adapter.confirmFill) {
    return { result, reconciliation: { venue: request.venueId, orderId: result.orderId, confirmation: null } };
  }
  const [reconciliation] = await reconcileLegs([adapter], [request], [result], {
    attempts: options.attempts ?? POLYMARKET_ANCHOR_CONFIRM_ATTEMPTS,
    delayMs: options.delayMs ?? POLYMARKET_ANCHOR_CONFIRM_POLL_MS,
    retryUnknown: true,
  });
  return {
    result: applyReconciliation([result], [reconciliation], [request])[0],
    reconciliation,
  };
}

// Match the hedge to what the anchor venue actually acknowledged. This avoids turning a
// 95%-filled anchor into a deliberately naked position merely because it missed the planned
// size by a fraction. Returning null means the confirmed quantity cannot form a valid venue
// order, so the normal recovery path remains responsible for it.
export function resizeHedgeToAnchorFill(request: OrderRequest, anchorFilledContracts: number): OrderRequest | null {
  const sizeContracts = Math.floor(Math.min(request.sizeContracts, Math.max(0, anchorFilledContracts)) * 100) / 100;
  if (
    sizeContracts <= 0 ||
    sizeContracts + 1e-9 < venueMinContracts(request.venueId) ||
    (sizeContracts * request.limitPriceCents) / 100 + 1e-9 < venueMinStakeUsd(request.venueId)
  ) {
    return null;
  }
  return { ...request, sizeContracts };
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

// Polymarket/Kalshi is submitted sequentially, so Polymarket only needs the executable FOK
// limit already observed. Put the available movement budget on Kalshi, whose IOC is sent
// after that fill. This lets the hedge cross a changed Kalshi ask without paying for the
// same cushion on the already-completed anchor leg.
export function applyVenueAwarePriceCushion(
  requests: OrderRequest[],
  legs: ArbLeg[],
  minExpectedProfitUsd: number,
  maxCushionCents: number,
  maxTotalCostUsd = Number.POSITIVE_INFINITY
): PriceCushionResult {
  if (!isPolymarketKalshiPair(requests)) {
    return applyEconomicPriceCushion(requests, legs, minExpectedProfitUsd, maxCushionCents, maxTotalCostUsd);
  }

  const kalshiIndex = requests.findIndex((request) => request.venueId === "kalshi");
  const ceiling = Math.max(0, Math.floor(maxCushionCents));
  let fallbackProfit = Number.NEGATIVE_INFINITY;
  for (let cushionCents = ceiling; cushionCents >= 0; cushionCents--) {
    const cushioned = requests.map((request, index) => ({
      ...request,
      limitPriceCents: index === kalshiIndex
        ? Math.min(99, request.limitPriceCents + cushionCents)
        : request.limitPriceCents,
    }));
    const worstCaseLegs = legs.map((leg, index) => {
      const priceCents = cushioned[index].limitPriceCents;
      return {
        ...leg,
        size: cushioned[index].sizeContracts,
        priceCents,
        impliedProbability: priceCents / 100,
        decimalOdds: 100 / priceCents,
      };
    });
    const fees = computeFees(worstCaseLegs);
    worstCaseLegs.forEach((leg, index) => (leg.feeCents = fees[index].feeCents));
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
  const explicit = normalizeAskLevels(quote.levels ?? []);
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
  results: OrderResult[],
  durable?: { reservation: RiskReservation; service?: RiskReservationService }
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
  if (targetContracts <= 0 || targetContracts - working[missingIndex].filledContracts <= CONTRACT_BALANCE_TOLERANCE + 1e-9) {
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
    if (missingContracts <= CONTRACT_BALANCE_TOLERANCE + 1e-9) break;
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

    const service = durable?.service ?? (durable ? getRiskReservationService() : null);
    let recoveryAttempt: ReturnType<RiskReservationService["allocateRecoveryAttempt"]> | null = null;
    if (durable && service) {
      recoveryAttempt = service.allocateRecoveryAttempt(
        durable.reservation,
        missingIndex,
        missingContracts,
        maxPriceCents,
        attempts
      );
      if (!recoveryAttempt.ok) {
        lastReason = recoveryAttempt.reason;
        break;
      }
      recoveryRequest.clientOrderId = recoveryAttempt.attempt.clientOrderId;
      if (!service.markRecoverySubmitting(durable.reservation, missingIndex, recoveryAttempt.attempt.attemptNumber)) {
        lastReason = "risk ledger fenced the recovery attempt before venue submission";
        break;
      }
    } else if (recoveryRequest.clientOrderId) {
      // Non-production/test callers still need a fresh idempotency key for a genuinely new
      // order. Live execution always uses the durable branch above.
      recoveryRequest.clientOrderId = randomUUID();
    }

    let placed: OrderResult;
    try {
      placed = await adapters[missingIndex].placeOrder(recoveryRequest);
    } catch (error) {
      if (durable && service && recoveryAttempt?.ok) {
        service.markRecoveryUncertain(durable.reservation, missingIndex, recoveryAttempt.attempt.attemptNumber, String(error));
      }
      lastReason = `recovery venue submission outcome is uncertain: ${String(error)}`;
      break;
    }
    const recoveryRecon = await reconcileLegs([adapters[missingIndex]], [recoveryRequest], [placed]);
    reconciliations.push(...recoveryRecon);
    const confirmed = applyReconciliation([placed], recoveryRecon, [recoveryRequest])[0];
    if (durable && service && recoveryAttempt?.ok) {
      if (!service.recordRecoveryResult(durable.reservation, missingIndex, recoveryAttempt.attempt.attemptNumber, confirmed)) {
        lastReason = "risk ledger refused the recovery acknowledgement";
        break;
      }
    }
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

function liveOpenTrade(trade: Trade): boolean {
  return trade.mode === "live" && (trade.status === "open" || trade.status === "partial" || trade.status === "naked");
}

function tradeVenueExposure(trade: Trade): Record<string, number> {
  const exposure: Record<string, number> = {};
  for (const leg of trade.legs) {
    exposure[leg.venueId] = (exposure[leg.venueId] ?? 0) + (leg.size * leg.priceCents) / 100;
  }
  return exposure;
}

function reservationGeneration(opportunityId: string, detectedAt: string | undefined, requests: OrderRequest[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ opportunityId, detectedAt: detectedAt ?? null, legs: requests.map((request) => ({
      venueId: request.venueId,
      marketId: request.marketId,
      nativeMarketId: request.nativeMarketId,
      nativeSide: request.nativeSide,
      sizeContracts: request.sizeContracts,
      limitPriceCents: request.limitPriceCents,
    })) }))
    .digest("hex");
}

type RunResult = ExecutionOutcome & { mode: ExecMode; blockers: string[] };

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
  detectedAt?: string,
  detectedOpportunity?: ArbOpportunity
): Promise<RunResult> {
  const executionTiming: ExecutionTiming = {
    detectedAt,
    queueEnteredAt: new Date().toISOString(),
    legs: [],
  };
  // Live baskets may prepare concurrently. The SQLite reservation transaction below is the
  // sole risk authority: it atomically enforces duplicate, match, venue, and global exposure
  // caps before any venue I/O. This removes cross-match queue latency without weakening caps.
  executionTiming.executionStartedAt = new Date().toISOString();
  return runExecutionUnlocked(opportunityId, date, requestedMode, creds, detectedAt, executionTiming, detectedOpportunity);
}

async function runExecutionUnlocked(
  opportunityId: string,
  date: string,
  requestedMode: ExecMode,
  creds?: ExecCreds,
  detectedAt?: string,
  executionTiming: ExecutionTiming = { queueEnteredAt: new Date().toISOString(), executionStartedAt: new Date().toISOString(), legs: [] },
  detectedOpportunity?: ArbOpportunity
): Promise<RunResult> {
  const pipelineStartMs = Date.now();
  const prep = await prepareExecution(opportunityId, date, requestedMode, pipelineStartMs, executionTiming, detectedOpportunity);
  if (prep.kind === "halt") return { ...prep.outcome, mode: requestedMode === "live" ? "live" : "dry_run", blockers: [] };
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
          executionTiming,
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
    const circuitBlockers = ctx.venues.flatMap((venueId) => {
      const blocker = venueCircuitBlocker(venueId);
      return blocker ? [blocker] : [];
    });
    if (circuitBlockers.length) {
      const reason = `Live execution blocked - ${circuitBlockers.join("; ")}`;
      pushStep({ key: "venue_circuit", label: "Venue failure cooldown", status: "halt", detail: reason });
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
        effectiveMode: "blocked",
        gateBlockers: circuitBlockers,
        opportunityId: ctx.opportunityId,
        pipelineSteps: executionSteps,
        executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: circuitBlockers };
    }
  }

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
        { effectiveMode: "blocked", gateBlockers: minStakeBlockers, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps, executionTiming },
        date,
        "live"
      );
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: minStakeBlockers };
    }
  }

  // ── Build exact venue requests ───────────────────────────────────────────────
  // Most pairs submit concurrently. Polymarket/Kalshi is handled as an anchored sequence
  // below: the actual Polymarket fill quantity controls the subsequent Kalshi IOC.
  const adapters: ExecutionAdapter[] = ctx.executedLegs.map((leg) => getAdapter(leg.venueId, mode, creds));
  let requests: OrderRequest[] = ctx.executedLegs.map((leg) => ({
    venueId: leg.venueId,
    marketId: leg.marketId,
    nativeMarketId: leg.nativeMarketId,
    nativeSide: leg.nativeSide,
    outcome: leg.outcome,
    expectedContract: leg.marketType && leg.teams
      ? {
          marketType: leg.marketType,
          line: leg.line ?? null,
          outcome: leg.outcome,
          teams: leg.teams,
          sourceStartTime: leg.sourceStartTime,
        }
      : undefined,
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
      askCents: (request) => preparedSnapshotLevels(ctx, request)?.[0]?.priceCents ?? liveAskCentsFor(request),
      depthAtOrBetter: (request, limitPriceCents) => {
        const levels = preparedSnapshotLevels(ctx, request);
        return levels
          ? levels.filter((level) => level.priceCents <= limitPriceCents).reduce((sum, level) => sum + level.contracts, 0)
          : liveDepthAtOrBetter(request, limitPriceCents);
      },
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
        { effectiveMode: "blocked", gateBlockers: liveCheck.blockers, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps, executionTiming },
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
      preparedSnapshotLevels(ctx, request) ?? (request.venueId === "polymarket" && request.nativeSide
        ? polymarketLiveBook.getAskLevels(request.nativeSide)
        : request.venueId === "kalshi" && request.nativeMarketId && request.nativeSide
          ? kalshiLiveBook.getAskLevels(request.nativeMarketId, request.nativeSide.toLowerCase() === "no" ? "no" : "yes")
          : null)
    );
    const canSkipQuoteProbe = liveOnly.canSkipRestProbe;
    executionTiming.quoteAcquisitionStartedAt = new Date().toISOString();
    const nativeQuotes = canSkipQuoteProbe
      ? (liveOnly.quotes as ExecutableOrderQuote[])
      : await Promise.all(
          adapters.map((adapter, i): Promise<ExecutableOrderQuote> => adapter.quoteOrder
            ? boundedNativeQuote(adapter.quoteOrder(depthProbeRequests[i]), requests[i].venueId)
            : Promise.resolve({
                ok: true,
                priceCents: requests[i].limitPriceCents,
                averagePriceCents: requests[i].limitPriceCents,
                availableContracts: depthProbeRequests[i].sizeContracts,
                levels: [{ priceCents: requests[i].limitPriceCents, contracts: depthProbeRequests[i].sizeContracts }],
              }))
        );
    executionTiming.quoteAcquisitionCompletedAt = new Date().toISOString();
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
    executionTiming.optimizerStartedAt = new Date().toISOString();
    const optimized = optimizeExecutableBasket(requests, quotes, depthBuffer, ctx.risk.minExpectedProfitUsd);
    executionTiming.optimizerCompletedAt = new Date().toISOString();
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
        { effectiveMode: "blocked", gateBlockers: optimized.blockers, executableQuotes: quotes, evaluatedSizes: optimized.evaluatedCount, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps, executionTiming },
        date,
        "live"
      );
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: optimized.blockers };
    }

    requests = optimized.requests;
    const polymarketIndex = requests.findIndex((request) => request.venueId === "polymarket");
    let polymarketEncoding: ReturnType<typeof polymarketV3BuyAmounts> = null;
    if (polymarketIndex >= 0) {
      const polymarketRequest = requests[polymarketIndex];
      const candidates = polymarketV3BuyAmountCandidates(polymarketRequest.sizeContracts, polymarketRequest.limitPriceCents);
      polymarketEncoding = candidates.reduce<PolymarketV3BuyAmounts | null>((best, candidate) => {
        const candidateLegs = ctx.executedLegs.map((leg, i) => ({
          ...leg,
          size: candidate.submittedContracts,
          priceCents: i === polymarketIndex ? candidate.effectiveLimitPriceCents : requests[i].limitPriceCents,
          feeCents: 0,
        }));
        const fees = computeFees(candidateLegs);
        candidateLegs.forEach((leg, i) => (leg.feeCents = fees[i].feeCents));
        const profit = executedEconomics(candidateLegs).expectedProfit;
        if (!best) return candidate;
        const bestLegs = ctx.executedLegs.map((leg, i) => ({
          ...leg,
          size: best.submittedContracts,
          priceCents: i === polymarketIndex ? best.effectiveLimitPriceCents : requests[i].limitPriceCents,
          feeCents: 0,
        }));
        const bestFees = computeFees(bestLegs);
        bestLegs.forEach((leg, i) => (leg.feeCents = bestFees[i].feeCents));
        return profit > executedEconomics(bestLegs).expectedProfit + 1e-9 ? candidate : best;
      }, null);
      if (!polymarketEncoding) {
        const blockers = ["Polymarket has no exchange-v3 precision-safe order of at least one contract below 100c"];
        const reason = `Live execution blocked - ${blockers[0]}`;
        await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
          effectiveMode: "blocked",
          gateBlockers: blockers,
          pipelineSteps: executionSteps,
          executionTiming,
        }, date, "live");
        return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers };
      }
      requests = requests.map((request, i) => ({
        ...request,
        sizeContracts: polymarketEncoding!.submittedContracts,
        limitPriceCents: i === polymarketIndex ? polymarketEncoding!.effectiveLimitPriceCents : request.limitPriceCents,
      }));
    }
    const executableLimits = requests.map((request) => request.limitPriceCents);
    const quotedLegs = ctx.executedLegs.map((leg, i) => ({
      ...leg,
      size: requests[i].sizeContracts,
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
        executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: economicBlockers };
    }
    const cushion = applyVenueAwarePriceCushion(
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
      detail: `${requestedContracts.toFixed(2)} requested -> ${requests[0].sizeContracts.toFixed(2)} exact common contracts; fresh ladder limits ${optimized.requests.map((request) => `${venueLabel(request.venueId)} ${request.limitPriceCents.toFixed(2)}c`).join(" / ")}${polymarketEncoding && polymarketEncoding.effectiveLimitPriceCents !== optimized.requests[polymarketIndex].limitPriceCents ? `; Polymarket precision-safe ceiling ${polymarketEncoding.effectiveLimitPriceCents.toFixed(2)}c` : ""}; ${depthBuffer.toFixed(1)}x depth; $${quotedEconomics.expectedProfit.toFixed(2)} executable profit after evaluating ${optimized.evaluatedCount} sizes`,
    });
    pushStep({
      key: "price_cushion",
      label: "Economics-safe submission ceilings",
      status: cushion.safe ? (cushion.cushionCents > 0 ? "pass" : "info") : "halt",
      detail: `${cushion.cushionCents.toFixed(0)}c ${isPolymarketKalshiPair(requests) ? "Kalshi hedge" : "shared"} movement allowance; observed limits ${executableLimits.map((limit, i) => `${venueLabel(requests[i].venueId)} ${limit.toFixed(2)}c`).join(" / ")}; submission ceilings ${requests.map((request) => `${venueLabel(request.venueId)} ${request.limitPriceCents.toFixed(2)}c`).join(" / ")}; worst-case profit $${cushion.worstCaseProfit.toFixed(2)}`,
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
        executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers };
    }

    executionTiming.recoveryValidationStartedAt = new Date().toISOString();
    const recoveryBlockers = recoveryPathBlockers(
      requests,
      quotes,
      quotedLegs,
      ctx.risk.hedgeRecoveryMaxSlippageCents ?? 10,
      ctx.risk.hedgeRecoveryMaxLossUsd ?? 1
    );
    executionTiming.recoveryValidationCompletedAt = new Date().toISOString();
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
        executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: recoveryBlockers };
    }
  }

  if (mode === "live") {
    const prepared = await Promise.all(adapters.map((adapter, index): Promise<{ ok: boolean; reason?: string }> =>
      adapter.prepareOrder ? adapter.prepareOrder(requests[index]) : Promise.resolve({ ok: true })
    ));
    const preparationBlockers = prepared.flatMap((result, index) =>
      result.ok ? [] : [`${venueLabel(requests[index].venueId)} order preparation failed: ${result.reason ?? "unknown error"}`]
    );
    if (preparationBlockers.length) {
      const reason = `Live execution blocked - ${preparationBlockers.join("; ")}`;
      pushStep({ key: "order_prepare", label: "Pre-signed venue payloads", status: "halt", detail: reason });
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
        effectiveMode: "blocked", gateBlockers: preparationBlockers, pipelineSteps: executionSteps, executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: preparationBlockers };
    }
    pushStep({ key: "order_prepare", label: "Pre-signed venue payloads", status: "pass", detail: "Venue payloads prepared before the durable submission fence" });
  }

  // Every live basket must obtain a durable atomic reservation. This is acquired
  // only after exact executable sizing, so caps cover the worst-case submission limits
  // rather than an earlier target-stake estimate.
  let riskReservation: RiskReservation | null = null;
  if (mode === "live") {
    executionTiming.reservationStartedAt = new Date().toISOString();
    let reservationService: ReturnType<typeof getRiskReservationService>;
    try {
      reservationService = getRiskReservationService();
    } catch (error) {
      const reason = `Live execution blocked - risk ledger unavailable; execution fails closed: ${String(error)}`;
      pushStep({ key: "risk_reservation", label: "Atomic risk reservation", status: "halt", detail: reason });
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
        effectiveMode: "blocked",
        gateBlockers: [reason],
        pipelineSteps: executionSteps,
        executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: [reason] };
    }
    // Import every legacy open live position, including prior slates. Once a position is
    // linked to a reservation the ledger de-duplicates it automatically.
    const existingTrades = (await getAllTrades()).filter(liveOpenTrade);
    const venueExposureUsd: Record<string, number> = {};
    for (const request of requests) {
      venueExposureUsd[request.venueId] = (venueExposureUsd[request.venueId] ?? 0) + (request.sizeContracts * request.limitPriceCents) / 100;
    }
    const exposureUsd = Object.values(venueExposureUsd).reduce((sum, amount) => sum + amount, 0);
    const quoteGeneration = reservationGeneration(opportunityId, detectedAt, requests);
    const acquired = reservationService.acquire({
      opportunityId,
      idempotencyKey: `${opportunityId}:${quoteGeneration}`,
      quoteGeneration,
      matchKey: opportunityMatchKey(opportunityId),
      date,
      ownerId: `${process.pid}:${randomUUID()}`,
      exposureUsd,
      venueExposureUsd,
      maxExposureUsd: ctx.risk.maxExposure,
      maxOpenPositionsPerMatch: ctx.risk.maxOpenPositions,
      perVenueCapsUsd: ctx.risk.perVenueCap,
      legs: requests.map((request) => ({
        venueId: request.venueId,
        marketId: request.marketId,
        nativeMarketId: request.nativeMarketId,
        nativeSide: request.nativeSide,
        outcome: request.outcome,
        sizeContracts: request.sizeContracts,
        limitPriceCents: request.limitPriceCents,
      })),
      existingOpenPositions: existingTrades.map((trade) => ({
        tradeId: trade.id,
        date: trade.date,
        matchKey: opportunityMatchKey(trade.opportunityId),
        exposureUsd: trade.totalCost,
        venueExposureUsd: tradeVenueExposure(trade),
      })),
    });
    if (!acquired.ok) {
      const reason = `Live execution blocked - ${acquired.reason}`;
      pushStep({ key: "risk_reservation", label: "Atomic risk reservation", status: "halt", detail: acquired.reason });
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
        effectiveMode: "blocked",
        gateBlockers: [acquired.reason],
        reservationCode: acquired.code,
        totalCost: exposureUsd,
        expectedProfit: ctx.expectedProfit,
        pipelineSteps: executionSteps,
        executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: [acquired.reason] };
    }
    riskReservation = acquired.reservation;
    executionTiming.reservationCompletedAt = new Date().toISOString();
    pushStep({
      key: "risk_reservation",
      label: "Atomic risk reservation",
      status: "pass",
      detail: `Reserved $${exposureUsd.toFixed(2)} with fencing token ${riskReservation.fencingToken}; independent matches may execute concurrently`,
    });
    if (!reservationService.beginSubmission(riskReservation)) {
      const reason = "Live execution blocked - risk reservation expired or its fencing token is no longer current";
      pushStep({ key: "reservation_fence", label: "Reservation fencing", status: "halt", detail: reason });
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
        effectiveMode: "blocked",
        gateBlockers: [reason],
        reservationId: riskReservation.id,
        pipelineSteps: executionSteps,
        executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: [reason] };
    }
    pushStep({ key: "reservation_fence", label: "Reservation fencing", status: "pass", detail: "Exclusive reservation lease validated immediately before venue submission" });

    if (riskReservation.legs.length !== requests.length) {
      reservationService.releaseAfterConfirmedNoFill(riskReservation, "reservation leg plan count mismatch before submission");
      const reason = "Live execution blocked - persisted reservation leg plan does not match the executable basket";
      pushStep({ key: "reservation_legs", label: "Persisted leg plan", status: "halt", detail: reason });
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
        effectiveMode: "blocked", gateBlockers: [reason], reservationId: riskReservation.id, pipelineSteps: executionSteps, executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: [reason] };
    }
    requests = requests.map((request, index) => ({ ...request, clientOrderId: riskReservation!.legs[index].clientOrderId }));
    const legPlanReady = requests.every((_, index) => reservationService.markLegSubmitting(riskReservation!, index));
    if (!legPlanReady) {
      reservationService.releaseAfterConfirmedNoFill(riskReservation, "could not fence every leg before submission");
      const reason = "Live execution blocked - could not atomically fence every persisted leg before submission";
      pushStep({ key: "reservation_legs", label: "Persisted leg plan", status: "halt", detail: reason });
      await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "live_blocked", reason, {
        effectiveMode: "blocked", gateBlockers: [reason], reservationId: riskReservation.id, pipelineSteps: executionSteps, executionTiming,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: [reason] };
    }
    pushStep({
      key: "reservation_legs",
      label: "Persisted leg plan",
      status: "pass",
      detail: `${requests.length} exact legs persisted and fenced with deterministic client order identifiers before venue I/O`,
    });
  }

  const placeTracked = async (adapter: ExecutionAdapter, index: number): Promise<OrderResult> => {
    const legTiming = (executionTiming.legs[index] ??= { venueId: requests[index].venueId });
    legTiming.dispatchedAt = new Date().toISOString();
    try {
      const result = await adapter.placeOrder(requests[index]);
      legTiming.httpResponseAt = new Date().toISOString();
      if (result.ok) clearVenueFailure(requests[index].venueId);
      else recordVenueFailure(requests[index].venueId, result.error);
      if (riskReservation && !getRiskReservationService().recordLegResult(riskReservation, index, result)) {
        throw new Error(`risk ledger refused the ${venueLabel(requests[index].venueId)} acknowledgement`);
      }
      return result;
    } catch (error) {
      legTiming.httpResponseAt = new Date().toISOString();
      if (riskReservation) {
        getRiskReservationService().markLegUncertain(riskReservation, index, String(error));
      }
      throw error;
    }
  };

  let placed: OrderResult[];
  const sequencingOrder = mode === "live" ? fragileVenueFirstOrder(requests) : requests.map((_, i) => i);
  const shouldSequence = mode === "live" && shouldSequenceFragileVenuePair(requests);

  try {
    if (shouldSequence) {
      placed = new Array<OrderResult>(requests.length);
      const [first, ...rest] = sequencingOrder;
      placed[first] = await placeTracked(adapters[first], first);
      if (requests[first].venueId === "polymarket" && placed[first].status === "pending") {
        const confirmation = await confirmPendingAnchor(adapters[first], requests[first], placed[first]);
        placed[first] = confirmation.result;
        if (confirmation.reconciliation.confirmationCompletedAt) {
          (executionTiming.legs[first] ??= { venueId: requests[first].venueId }).fillConfirmedAt = confirmation.reconciliation.confirmationCompletedAt;
        }
        if (riskReservation && !getRiskReservationService().recordLegResult(riskReservation, first, placed[first])) {
          throw new Error(`risk ledger refused the confirmed ${venueLabel(requests[first].venueId)} anchor result`);
        }
        pushStep({
          key: "anchor_confirmation",
          label: "Polymarket anchor confirmation",
          status: placed[first].status === "pending" ? "warn" : placed[first].filledContracts > 0 ? "pass" : "halt",
          detail: placed[first].status === "pending"
            ? `Polymarket anchor is still pending after ${POLYMARKET_ANCHOR_CONFIRM_ATTEMPTS} checks at ${POLYMARKET_ANCHOR_CONFIRM_POLL_MS}ms intervals; Kalshi remains withheld until reconciliation resolves the original order`
            : placed[first].filledContracts > 0
              ? `Polymarket confirmed ${placed[first].filledContracts.toFixed(2)} contracts before Kalshi submission`
              : "Polymarket confirmed zero fill; Kalshi was not submitted",
        });
      }
      if (placed[first].filledContracts <= 0) {
        const firstVenue = venueLabel(requests[first].venueId);
        const error = `not submitted because ${firstVenue} anchor leg did not fill: ${placed[first].error ?? placed[first].status}`;
        for (const i of rest) {
          placed[i] = skippedBecausePriorLegFailed(requests[i], error);
          if (riskReservation && !getRiskReservationService().recordLegResult(riskReservation, i, placed[i])) {
            throw new Error(`risk ledger refused the skipped ${venueLabel(requests[i].venueId)} leg result`);
          }
        }
      } else {
        const hedgeIndexes: number[] = [];
        for (const i of rest) {
          const resized = resizeHedgeToAnchorFill(requests[i], placed[first].filledContracts);
          if (!resized) {
            const error = `not submitted because ${venueLabel(requests[first].venueId)} filled ${placed[first].filledContracts.toFixed(2)} contracts, below ${venueLabel(requests[i].venueId)}'s hedge minimum`;
            placed[i] = skippedBecausePriorLegFailed(requests[i], error);
            if (riskReservation && !getRiskReservationService().recordLegResult(riskReservation, i, placed[i])) {
              throw new Error(`risk ledger refused the skipped ${venueLabel(requests[i].venueId)} leg result`);
            }
            continue;
          }
          requests[i] = resized;
          hedgeIndexes.push(i);
        }
        if (placed[first].filledContracts + 1e-9 < requests[first].sizeContracts) {
          pushStep({
            key: "anchor_partial_resize",
            label: "Anchor partial-fill hedge",
            status: "warn",
            detail: `${venueLabel(requests[first].venueId)} filled ${placed[first].filledContracts.toFixed(2)} of ${requests[first].sizeContracts.toFixed(2)} contracts; resized the immediate hedge to the confirmed fill`,
          });
        }
        const restResults = await Promise.all(hedgeIndexes.map((i) => placeTracked(adapters[i], i)));
        hedgeIndexes.forEach((i, idx) => { placed[i] = restResults[idx]; });
      }
    } else {
      placed = await Promise.all(adapters.map((a, i) => placeTracked(a, i)));
    }
  } catch (error) {
    if (riskReservation) getRiskReservationService().markUncertain(riskReservation, null, `venue submission threw: ${String(error)}`);
    const reason = `Venue submission outcome is uncertain; reservation remains exposure-blocking: ${String(error)}`;
    pushStep({ key: "execute", label: "Leg execution", status: "halt", detail: reason });
    await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "hedge_failed", reason, {
      effectiveMode: mode,
      reservationId: riskReservation?.id ?? null,
      pipelineSteps: executionSteps,
      executionTiming,
    }, date, mode === "live" ? "live" : "paper");
    return { result: "halted", reasonCode: "hedge_failed", reason, trade: null, mode, blockers: [reason] };
  }

  // ── Reconcile settlement (live only) ────────────────────────────────────────
  // Re-query venues to confirm the orders actually settled (on-chain venues ack before
  // finality). Folds an explicit settlement failure back into the fill counts so a
  // half-settled arb is correctly flagged naked instead of falsely reported filled.
  let reconciliation: LegReconciliation[] = [];
  let results = placed;
  if (mode === "live") {
    reconciliation = await reconcileLegs(adapters, requests, placed);
    reconciliation.forEach((item, index) => {
      if (item.confirmationCompletedAt) {
        (executionTiming.legs[index] ??= { venueId: requests[index].venueId }).fillConfirmedAt = item.confirmationCompletedAt;
      }
    });
    results = applyReconciliation(placed, reconciliation, requests);
    if (riskReservation) {
      results.forEach((result, index) => {
        if (!getRiskReservationService().recordLegResult(riskReservation!, index, result)) {
          throw new Error(`risk ledger refused reconciled result for leg ${index}`);
        }
      });
    }
    const recovery = await recoverMissingHedge(
      ctx,
      adapters,
      requests,
      results,
      riskReservation ? { reservation: riskReservation } : undefined
    );
    results = recovery.results;
    reconciliation.push(...recovery.reconciliations);
    if (recovery.step) pushStep(recovery.step);
  }

  // ── Derive position status from per-leg fills ───────────────────────────────
  const filledFlags = results.map((r) => r.filledContracts > 0);
  const minFilledContracts = Math.min(...results.map((r) => r.filledContracts));
  const maxFilledContracts = Math.max(...results.map((r) => r.filledContracts));
  const fillImbalanceContracts = maxFilledContracts - minFilledContracts;
  const balanced = fillImbalanceContracts <= CONTRACT_BALANCE_TOLERANCE + 1e-9;
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
  // portfolio shows the guaranteed result of the fill, not the pre-trade quote. Fees are
  // re-derived and retained per leg, but estimated fees are reported separately rather than
  // being mixed into the locked payout-minus-cost profit shown for the trade.
  const legFees = computeFees(legs);
  legs.forEach((l, i) => (l.feeCents = legFees[i].feeCents));
  const econ = guaranteedTradeEconomics(legs);

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
          executionTiming,
          detectedAt,
          reservationId: riskReservation?.id,
        };

  if (riskReservation) {
    const reservationService = getRiskReservationService();
    let transitioned: boolean;
    if (!trade) {
      // Reconciliation proved every leg terminal with zero fill. This is the only
      // post-submission path allowed to free capacity without a trade settlement.
      transitioned = reservationService.releaseAfterConfirmedNoFill(riskReservation, "all venue legs confirmed zero fill");
    } else if (status === "open" || (status === "partial" && !anyPending && balanced)) {
      transitioned = reservationService.markCommitted(riskReservation, trade.id);
    } else {
      transitioned = reservationService.markUncertain(riskReservation, trade.id, reason);
    }
    pushStep({
      key: "reservation_commit",
      label: "Risk reservation finalization",
      status: transitioned ? (trade && (status === "naked" || anyPending) ? "warn" : "pass") : "halt",
      detail: transitioned
        ? !trade
          ? "All legs confirmed zero-fill; reservation released"
          : status === "naked" || anyPending
            ? "Submission remains uncertain/unhedged and continues blocking risk capacity"
            : "Reservation committed to the persisted live position"
        : "Reservation transition failed; its submitting state remains fail-closed and exposure-blocking",
    });
  }

  const postFill = trade ? await verifyPostFill(ctx.opportunityId, date, ctx.netAfter) : undefined;
  executionTiming.completedAt = new Date().toISOString();
  if (trade) {
    trade.executionTiming = executionTiming;
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
      reservationId: riskReservation?.id ?? null,
      reservationFencingToken: riskReservation?.fencingToken ?? null,
      opportunityId: ctx.opportunityId,
      pipelineSteps: trade?.executionSteps ?? executionSteps,
      executionTiming,
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
