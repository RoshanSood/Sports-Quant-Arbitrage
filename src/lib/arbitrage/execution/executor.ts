// The real executor. Runs the shared pre-execution checks, resolves the effective
// mode through the safety gate (defaults to dry-run unless EVERY live switch is on),
// then places each leg through its venue adapter and records the Trade + log. Dry-run
// and live share this exact path — only the adapter differs.

import type { ArbLeg, Trade } from "@/types/arbitrage";
import { saveTrade } from "../tradeStore";
import { prepareExecution, verifyPostFill, writeLog, type ExecutionOutcome } from "../executionPipeline";
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
      const move = bumped - limitPriceCents;
      if (move > LIVE_PRICE_CUSHION_CENTS) {
        blockers.push(
          `${venueLabel(r.venueId)} live ask moved to ${bumped}c (from ${limitPriceCents}c), beyond the ${LIVE_PRICE_CUSHION_CENTS}c cushion`
        );
        return r;
      }
      adjustments.push({ venueId: r.venueId, fromCents: limitPriceCents, toCents: bumped });
      limitPriceCents = bumped;
    }
    const depth = live.depthAtOrBetter(r, limitPriceCents);
    if (depth != null && depth + 1e-9 < r.sizeContracts) {
      blockers.push(
        `${venueLabel(r.venueId)} live depth ${depth.toFixed(2)} contracts at <= ${limitPriceCents}c is short of the ${r.sizeContracts} required`
      );
    }
    return limitPriceCents === r.limitPriceCents ? r : { ...r, limitPriceCents };
  });
  return { requests: next, blockers, adjustments };
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
  creds?: ExecCreds
): Promise<RunResult> {
  // One live basket at a time per server process. This ensures the completed trade is saved
  // before the next queued request checks the Risk panel's per-match open-position limit.
  // Paper simulations remain concurrent.
  return requestedMode === "live"
    ? serializeLiveExecution(() => runExecutionUnlocked(opportunityId, date, requestedMode, creds))
    : runExecutionUnlocked(opportunityId, date, requestedMode, creds);
}

async function runExecutionUnlocked(
  opportunityId: string,
  date: string,
  requestedMode: ExecMode,
  creds?: ExecCreds
): Promise<RunResult> {
  const prep = await prepareExecution(opportunityId, date, requestedMode);
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
            { key: "exec_mode", label: "Execution mode", status: "halt", detail: "Live request blocked before order placement" },
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
  executionSteps.push({
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
      executionSteps.push({
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

    // Quote every venue-native executable book concurrently, then use exactly the same
    // contract count on every leg. Polymarket walks the real CLOB ask ladder here, so a
    // three-contract basket proceeds only when all three shares are actually offered at or
    // below our limit (or all legs are uniformly resized to a smaller valid common count).
    const depthBuffer = Math.max(1, ctx.risk.liquidityStakeBufferMultiple);
    const depthProbeRequests = requests.map((request) => ({
      ...request,
      sizeContracts: request.sizeContracts * depthBuffer,
    }));
    const quotes = await Promise.all(
      adapters.map((adapter, i): Promise<ExecutableOrderQuote> => adapter.quoteOrder
        ? adapter.quoteOrder(depthProbeRequests[i])
        : Promise.resolve({
            ok: true,
            priceCents: requests[i].limitPriceCents,
            averagePriceCents: requests[i].limitPriceCents,
            availableContracts: depthProbeRequests[i].sizeContracts,
          }))
    );
    const resized = commonExecutableRequests(requests, quotes, depthBuffer);
    if (resized.blockers.length) {
      const reason = `Live execution blocked - ${resized.blockers.join("; ")}`;
      await writeLog(
        ctx.agent,
        ctx.opportunityMatchup,
        ctx.venues,
        ctx.netAfter,
        "halted",
        "live_blocked",
        reason,
        { effectiveMode: "blocked", gateBlockers: resized.blockers, executableQuotes: quotes, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps },
        date,
        "live"
      );
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: resized.blockers };
    }

    requests = resized.requests;
    const quotedLegs = ctx.executedLegs.map((leg, i) => ({
      ...leg,
      size: resized.commonContracts,
      priceCents: requests[i].limitPriceCents,
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
        commonContracts: resized.commonContracts,
        submittedStakesUsd: quotedLegs.map((leg) => Number(((leg.size * leg.priceCents) / 100).toFixed(4))),
        totalCost: quotedEconomics.totalCost,
        expectedProfit: quotedEconomics.expectedProfit,
        pipelineSteps: executionSteps,
      }, date, "live");
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: economicBlockers };
    }
    executionSteps.push({
      key: "executable_books",
      label: "Executable books",
      status: "pass",
      detail: `${resized.commonContracts.toFixed(2)} exact common contracts across every leg with ${depthBuffer.toFixed(1)}x depth; $${quotedEconomics.expectedProfit.toFixed(2)} executable profit`,
    });
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
    results = applyReconciliation(placed, reconciliation);
  }

  // ── Derive position status from per-leg fills ───────────────────────────────
  const filledFlags = results.map((r) => r.filledContracts > 0);
  const fullyFilled = results.every((r, i) => r.filledContracts + 1e-9 >= requests[i].sizeContracts);
  const anyFilled = filledFlags.some(Boolean);
  const allFilled = filledFlags.every(Boolean);

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
  } else if (allFilled) {
    status = "partial";
    fillStatus = "partial";
    result = "partial";
    reason = "Partial fill — reduced size";
  } else if (anyFilled) {
    status = "naked";
    fillStatus = "partial";
    result = "naked";
    reasonCode = "naked_position";
    reason = "One leg filled, the hedge did not — unhedged exposure";
    nakedLegIndex = filledFlags.findIndex(Boolean);
  } else {
    // Nothing filled — treat as a hedge failure with no exposure.
    status = "failed";
    fillStatus = "failed";
    result = "halted";
    reasonCode = "hedge_failed";
    reason = results.find((r) => r.error)?.error ?? "No legs filled";
  }
  executionSteps.push({
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
      orders: results.map((r, i) => ({ venue: ctx.executedLegs[i].venueId, orderId: r.orderId, status: r.status, filled: r.filledContracts, error: r.error })),
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
