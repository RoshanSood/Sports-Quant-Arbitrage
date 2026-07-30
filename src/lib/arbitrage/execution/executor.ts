// The real executor. Runs the shared pre-execution checks, resolves the effective
// mode through the safety gate (defaults to dry-run unless EVERY live switch is on),
// then places each leg through its venue adapter and records the Trade + log. Dry-run
// and live share this exact path — only the adapter differs.

import type { ArbLeg, Trade } from "@/types/arbitrage";
import { saveTrade, updateTrade } from "../tradeStore";
import { prepareExecution, verifyPostFill, writeLog, POLYMARKET_MIN_MARKET_BUY_USD, type ExecutionOutcome } from "../executionPipeline";
import { resolveExecutionMode, type ExecMode } from "./config";
import { getAdapter, venueSupportsLive, type ExecCreds } from "./registry";
import type { PolymarketCreds } from "./onchainCreds";
import { applyReconciliation, reconcileLegs, type LegReconciliation } from "./reconcile";
import { checkKalshiFillability } from "./kalshiAdapter";
import { quotePolymarketFokBuy } from "./polymarketAdapter";
import { quotePolymarketUsFokBuy } from "./polymarketUsAdapter";
import { checkSxFillability } from "./sxbetAdapter";
import { polymarketRegion } from "@/lib/polymarketRegion";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";
import { computeFees, feeFractionOfStake } from "../feeEngine";
import { centsToDollars } from "../arbMath";

export const SXBET_MIN_TAKER_STAKE_USD = 1;
const POLYMARKET_FOK_RETRY_ATTEMPTS = 2;
const POLYMARKET_FOK_RETRY_DELAY_MS = 300;
// How far above the detected price the anchor may walk the ask ladder before giving up.
// The live ask commonly sits several cents above the resting quote, so a 1c ceiling
// filtered out the very levels that could fill (the #1 logged failure: "no live ask
// depth"). buildPolymarketBookResize still recomputes netEdge/expectedProfit AFTER the
// walk and rejects anything that erodes edge below the agent minimum, so a wider ceiling
// is bounded by an honest edge gate — not naked risk.
const POLYMARKET_FOK_MAX_CUSHION_CENTS = 8;

// The price ceiling the anchor is allowed to pay up to. Kept as a function so preflight
// and retry share one definition.
export function polymarketAnchorCeiling(baseLimitCents: number): number {
  return Math.min(99, baseLimitCents + POLYMARKET_FOK_MAX_CUSHION_CENTS);
}

export function liveVenueMinimumStakeBlockers(legs: ArbLeg[]): string[] {
  return legs.flatMap((leg) => {
    if (leg.venueId !== "sxbet") return [];
    const stakeUsd = (leg.size * leg.priceCents) / 100;
    if (stakeUsd >= SXBET_MIN_TAKER_STAKE_USD) return [];
    const label = leg.label ? ` ${leg.label}` : "";
    return [`SX.bet${label} stake $${stakeUsd.toFixed(2)} is below minimum $${SXBET_MIN_TAKER_STAKE_USD}`];
  });
}

export async function liveSxFillabilityBlockers(requests: OrderRequest[]): Promise<string[]> {
  const checks = await Promise.all(
    requests.map(async (req) => {
      if (req.venueId !== "sxbet") return null;
      const result = await checkSxFillability(req);
      return result.ok ? null : result.reason ?? "SX.bet has no fillable maker liquidity for this leg";
    })
  );
  return checks.filter((b): b is string => Boolean(b));
}

export async function liveKalshiFillabilityBlockers(requests: OrderRequest[], creds?: ExecCreds): Promise<string[]> {
  const checks = await Promise.all(
    requests.map(async (req) => {
      if (req.venueId !== "kalshi") return null;
      const result = await checkKalshiFillability(req, creds?.kalshiCreds);
      return result.ok ? null : result.reason ?? "Kalshi has no fillable top-of-book liquidity for this leg";
    })
  );
  return checks.filter((b): b is string => Boolean(b));
}

function venueLabel(venueId: string): string {
  if (venueId === "sxbet") return "SX.bet";
  if (venueId === "predictfun") return "Predict.fun";
  if (venueId === "polymarket") return "Polymarket";
  if (venueId === "kalshi") return "Kalshi";
  return venueId;
}

export function fragileVenueFirstOrder(requests: OrderRequest[]): number[] {
  const hasSx = requests.some((r) => r.venueId === "sxbet");
  const hasPredictFun = requests.some((r) => r.venueId === "predictfun");
  const hasPolymarket = requests.some((r) => r.venueId === "polymarket");
  const hasKalshi = requests.some((r) => r.venueId === "kalshi");
  const indexes = requests.map((_, i) => i);
  if (!hasPredictFun && !(hasSx && hasKalshi) && (!hasPolymarket || requests.length < 2)) return indexes;
  return indexes.sort((a, b) => {
    const av = requests[a].venueId;
    const bv = requests[b].venueId;
    if (hasPolymarket) {
      if (av === "polymarket" && bv !== "polymarket") return -1;
      if (av !== "polymarket" && bv === "polymarket") return 1;
    }
    if (!hasPolymarket) {
      if (av === "predictfun" && bv !== "predictfun") return -1;
      if (av !== "predictfun" && bv === "predictfun") return 1;
    }
    if (hasSx && hasKalshi) {
      if (av === "kalshi" && bv !== "kalshi") return -1;
      if (av !== "kalshi" && bv === "kalshi") return 1;
    }
    if (av === "sxbet" && bv !== "sxbet") return -1;
    if (av !== "sxbet" && bv === "sxbet") return 1;
    return a - b;
  });
}

export function shouldSequenceFragileVenuePair(requests: OrderRequest[]): boolean {
  const hasPredictFun = requests.some((r) => r.venueId === "predictfun");
  const hasPolymarket = requests.some((r) => r.venueId === "polymarket");
  const hasSx = requests.some((r) => r.venueId === "sxbet");
  const hasKalshi = requests.some((r) => r.venueId === "kalshi");
  return (hasPolymarket && requests.length > 1) || (hasPredictFun && requests.length > 1) || (hasSx && hasKalshi);
}

function skippedBecausePriorLegFailed(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPolymarketFokFailure(req: OrderRequest, result: OrderResult): boolean {
  if (req.venueId !== "polymarket") return false;
  if (result.ok && result.filledContracts >= req.sizeContracts) return false;
  const message = `${result.error ?? ""} ${result.status ?? ""}`;
  // Include the preflight book-check failures ("preflight failed" / "no live ask depth"):
  // a thin/empty book at attempt time is often transient, so it should get the same
  // requote-and-resize retries as a killed FOK order rather than instantly dooming the arb.
  return /FOK|fill or kill|fully filled|not filled|unfilled|couldn't be fully filled|preflight failed|no live ask depth/i.test(message);
}

function floorContracts(value: number): number {
  return Math.floor((value + Number.EPSILON) * 10_000) / 10_000;
}

// Read the live ask book the Polymarket order will ACTUALLY hit: the regulated US
// central book (slug + yes/no side) vs the intl self-custody CLOB (ERC-1155 token id).
// Reading the wrong one made the pre-order depth check meaningless (or hard-blocked
// every US order, since a yes/no "token id" is not a valid intl order-book key).
function polymarketFokQuote(req: OrderRequest, creds: PolymarketCreds | undefined, maxPriceCents: number) {
  return (
    polymarketRegion() === "us"
      ? quotePolymarketUsFokBuy(req, creds, maxPriceCents)
      : quotePolymarketFokBuy(req, creds, maxPriceCents)
  ).catch(() => null);
}

export async function runExecution(
  opportunityId: string,
  date: string,
  requestedMode: ExecMode,
  creds?: ExecCreds
): Promise<ExecutionOutcome & { mode: ExecMode; blockers: string[] }> {
  const prep = await prepareExecution(opportunityId, date, requestedMode);
  if (prep.kind === "halt") return { ...prep.outcome, mode: "dry_run", blockers: [] };
  const ctx = prep.ctx;

  // ── Resolve the execution decision through the hard gate ────────────────────
  const gate = resolveExecutionMode({
    requestedMode,
    agentPaper: ctx.agent.paper,
    agentLive: ctx.agent.live,
    killSwitch: ctx.risk.killSwitch,
    venues: ctx.venues,
    stakeUsd: ctx.totalStake,
    maxLiveStakeUsd: ctx.risk.maxLiveStakeUsd,
    ignoreLiveStakeCap: ctx.venues.includes("polymarket"),
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
  let activeLegs = ctx.executedLegs;
  let activeTotalStake = ctx.totalStake;
  let activeExpectedProfit = ctx.expectedProfit;
  let activeNetAfter = ctx.netAfter;
  let activeFees = ctx.fees;
  const adapters: ExecutionAdapter[] = activeLegs.map((leg) => getAdapter(leg.venueId, mode, creds));
  let requests: OrderRequest[] = activeLegs.map((leg) => ({
    venueId: leg.venueId,
    marketId: leg.marketId,
    nativeMarketId: leg.nativeMarketId,
    nativeSide: leg.nativeSide,
    outcome: leg.outcome,
    sizeContracts: leg.size,
    limitPriceCents: leg.priceCents,
  }));

  // Per-leg order-submission timing: submit start/end + venue round-trip response time.
  type OrderTiming = { venueId: string; attempt: number; submitStartedAt: string; submitCompletedAt: string; venueResponseMs: number };
  const orderTimings: OrderTiming[] = [];
  const placeTimed = async (index: number, attempt = 1): Promise<OrderResult> => {
    const start = Date.now();
    const res = await adapters[index].placeOrder(requests[index]);
    const end = Date.now();
    orderTimings.push({
      venueId: requests[index].venueId,
      attempt,
      submitStartedAt: new Date(start).toISOString(),
      submitCompletedAt: new Date(end).toISOString(),
      venueResponseMs: end - start,
    });
    return res;
  };

  const applyResizedRequests = (nextRequests: OrderRequest[]) => {
    requests = nextRequests;
    activeLegs = activeLegs.map((leg, i) => {
      const r = nextRequests[i];
      return {
        ...leg,
        size: r.sizeContracts,
        priceCents: r.limitPriceCents,
        decimalOdds: 100 / r.limitPriceCents,
        impliedProbability: r.limitPriceCents / 100,
      };
    });
    const legSizes: Record<string, number> = {};
    for (const leg of activeLegs) legSizes[leg.venueId] = centsToDollars(leg.priceCents) * leg.size;
    activeFees = computeFees(activeLegs);
    activeLegs.forEach((leg, i) => (leg.feeCents = activeFees[i].feeCents));
    activeTotalStake = Object.values(legSizes).reduce((sum, value) => sum + value, 0);
    const priceSum = activeLegs.reduce((sum, leg) => sum + leg.priceCents, 0);
    const gross = (100 - priceSum) / priceSum;
    activeNetAfter = Number((gross - feeFractionOfStake(activeFees, legSizes)).toFixed(6));
    const totalFeeDollars = activeFees.reduce((sum, fee) => sum + fee.feeCents / 100, 0);
    activeExpectedProfit = Number((activeLegs[0].size - activeTotalStake - totalFeeDollars).toFixed(2));
  };

  const buildPolymarketBookResize = async (
    index: number,
    maxPriceCents: number
  ): Promise<{ ok: true; requests: OrderRequest[]; size: number; limit: number; netAfter: number; expectedProfit: number } | { ok: false; reason: string }> => {
    const quote = await polymarketFokQuote(requests[index], creds?.polymarket, maxPriceCents);
    if (!quote) return { ok: false, reason: `no live ask depth at ${maxPriceCents.toFixed(2)}c or better` };

    const nextSize = floorContracts(Math.min(requests[index].sizeContracts, quote.availableContracts));
    if (nextSize <= 0) return { ok: false, reason: "live ask depth rounds to zero contracts" };

    const nextLimit = Math.min(99, Math.max(requests[index].limitPriceCents, quote.limitPriceCents));
    // Never shrink the Polymarket leg below the $1 marketable-buy floor the pipeline enforced —
    // a sub-$1 FOK BUY is rejected by Polymarket, so treat thin depth as unfillable here.
    const nextCostUsd = centsToDollars(nextLimit) * nextSize;
    if (nextCostUsd < POLYMARKET_MIN_MARKET_BUY_USD) {
      return { ok: false, reason: `live ask depth only supports $${nextCostUsd.toFixed(2)}, below Polymarket $${POLYMARKET_MIN_MARKET_BUY_USD.toFixed(2)} min marketable buy` };
    }
    const nextRequests = requests.map((req, i) => ({
      ...req,
      sizeContracts: nextSize,
      limitPriceCents: i === index ? nextLimit : req.limitPriceCents,
    }));

    const candidateLegs = activeLegs.map((leg, i) => ({
      ...leg,
      size: nextRequests[i].sizeContracts,
      priceCents: nextRequests[i].limitPriceCents,
      decimalOdds: 100 / nextRequests[i].limitPriceCents,
      impliedProbability: nextRequests[i].limitPriceCents / 100,
    }));
    const legSizes: Record<string, number> = {};
    for (const leg of candidateLegs) legSizes[leg.venueId] = centsToDollars(leg.priceCents) * leg.size;
    const fees = computeFees(candidateLegs);
    const totalStake = Object.values(legSizes).reduce((sum, value) => sum + value, 0);
    const totalCents = candidateLegs.reduce((sum, leg) => sum + leg.priceCents, 0);
    const netAfter = Number((((100 - totalCents) / totalCents) - feeFractionOfStake(fees, legSizes)).toFixed(6));
    const expectedProfit = Number((candidateLegs[0].size - totalStake - fees.reduce((sum, fee) => sum + fee.feeCents / 100, 0)).toFixed(2));
    if (netAfter < ctx.agent.minEdge || expectedProfit < (ctx.risk.minExpectedProfitUsd ?? 0)) {
      return { ok: false, reason: `refreshed edge/profit failed (${(netAfter * 100).toFixed(2)}%, $${expectedProfit.toFixed(2)})` };
    }
    return { ok: true, requests: nextRequests, size: nextSize, limit: nextLimit, netAfter, expectedProfit };
  };

  // Placement sequencing (fragile venue first). Hoisted here so the Polymarket anchor's
  // book preflight can run CONCURRENTLY with the SX/Kalshi fillability reads below instead
  // of as a second serial round-trip before placement.
  const sequencingOrder = mode === "live" ? fragileVenueFirstOrder(requests) : requests.map((_, i) => i);
  const shouldSequence = mode === "live" && shouldSequenceFragileVenuePair(requests);
  const anchorIndex = shouldSequence ? sequencingOrder[0] : -1;
  const polymarketAnchorIndex = anchorIndex >= 0 && requests[anchorIndex].venueId === "polymarket" ? anchorIndex : -1;

  if (mode === "live") {
    // All three reads hit independent venues; the Polymarket resize only ever SHRINKS size,
    // so running the SX/Kalshi fillability against the pre-resize (larger) size is safe.
    const [sxBlockers, kalshiBlockers, anchorResize] = await Promise.all([
      liveSxFillabilityBlockers(requests),
      liveKalshiFillabilityBlockers(requests, creds),
      polymarketAnchorIndex >= 0
        ? buildPolymarketBookResize(polymarketAnchorIndex, polymarketAnchorCeiling(requests[polymarketAnchorIndex].limitPriceCents))
        : Promise.resolve(null),
    ]);
    const fillabilityBlockers = [...sxBlockers, ...kalshiBlockers];
    if (fillabilityBlockers.length) {
      const reason = `Live execution blocked - ${fillabilityBlockers.join("; ")}`;
      await writeLog(
        ctx.agent,
        ctx.opportunityMatchup,
        ctx.venues,
        ctx.netAfter,
        "halted",
        "live_blocked",
        reason,
        { effectiveMode: "blocked", gateBlockers: fillabilityBlockers, totalCost: ctx.totalStake, expectedProfit: ctx.expectedProfit, pipelineSteps: executionSteps },
        date,
        "live"
      );
      return { result: "halted", reasonCode: "live_blocked", reason, trade: null, mode: "live", blockers: fillabilityBlockers };
    }

    // Apply the concurrently-read Polymarket book preflight. On FAILURE do NOT block — the
    // anchor is still placed and retryPolymarketAnchor requotes/resizes (it catches
    // "preflight failed"/"no depth"). This just moves the read off the serial path.
    if (polymarketAnchorIndex >= 0 && anchorResize) {
      if (anchorResize.ok) {
        applyResizedRequests(anchorResize.requests);
        executionSteps.push({
          key: "polymarket_book_preflight",
          label: "Polymarket book preflight",
          status: "pass",
          detail: `live book supports ${anchorResize.size.toFixed(4)} contracts at ${anchorResize.limit.toFixed(2)}c limit (concurrent with fillability)`,
        });
      } else {
        executionSteps.push({
          key: "polymarket_book_preflight",
          label: "Polymarket book preflight",
          status: "warn",
          detail: `${anchorResize.reason} — placing anchor then retrying`,
        });
      }
    }
  }

  const retryPolymarketAnchor = async (index: number, firstResult: OrderResult): Promise<OrderResult> => {
    if (!isPolymarketFokFailure(requests[index], firstResult)) return firstResult;
    for (let attempt = 1; attempt <= POLYMARKET_FOK_RETRY_ATTEMPTS; attempt += 1) {
      await sleep(POLYMARKET_FOK_RETRY_DELAY_MS);
      const retryCeiling = polymarketAnchorCeiling(requests[index].limitPriceCents);
      const quote = await polymarketFokQuote(requests[index], creds?.polymarket, retryCeiling);
      if (!quote) {
        executionSteps.push({
          key: "polymarket_fok_retry",
          label: "Polymarket FOK retry",
          status: "warn",
          detail: `retry ${attempt}: no live ask depth at ${retryCeiling.toFixed(2)}c or better`,
        });
        continue;
      }

      const nextSize = floorContracts(Math.min(requests[index].sizeContracts, quote.availableContracts));
      if (nextSize <= 0) {
        executionSteps.push({
          key: "polymarket_fok_retry",
          label: "Polymarket FOK retry",
          status: "warn",
          detail: `retry ${attempt}: live ask depth rounds to zero contracts`,
        });
        continue;
      }
      const nextLimit = Math.min(99, Math.max(requests[index].limitPriceCents, quote.limitPriceCents));
      const nextCostUsd = centsToDollars(nextLimit) * nextSize;
      if (nextCostUsd < POLYMARKET_MIN_MARKET_BUY_USD) {
        executionSteps.push({
          key: "polymarket_fok_retry",
          label: "Polymarket FOK retry",
          status: "warn",
          detail: `retry ${attempt}: live ask depth only $${nextCostUsd.toFixed(2)}, below Polymarket $${POLYMARKET_MIN_MARKET_BUY_USD.toFixed(2)} min marketable buy`,
        });
        continue;
      }
      const nextRequests = requests.map((req, i) => ({
        ...req,
        sizeContracts: nextSize,
        limitPriceCents: i === index ? nextLimit : req.limitPriceCents,
      }));

      const candidateLegs = activeLegs.map((leg, i) => ({
        ...leg,
        size: nextRequests[i].sizeContracts,
        priceCents: nextRequests[i].limitPriceCents,
        decimalOdds: 100 / nextRequests[i].limitPriceCents,
        impliedProbability: nextRequests[i].limitPriceCents / 100,
      }));
      const legSizes: Record<string, number> = {};
      for (const leg of candidateLegs) legSizes[leg.venueId] = centsToDollars(leg.priceCents) * leg.size;
      const fees = computeFees(candidateLegs);
      const totalStake = Object.values(legSizes).reduce((sum, value) => sum + value, 0);
      const totalCents = candidateLegs.reduce((sum, leg) => sum + leg.priceCents, 0);
      const netAfter = Number((((100 - totalCents) / totalCents) - feeFractionOfStake(fees, legSizes)).toFixed(6));
      const expectedProfit = Number((candidateLegs[0].size - totalStake - fees.reduce((sum, fee) => sum + fee.feeCents / 100, 0)).toFixed(2));
      if (netAfter < ctx.agent.minEdge || expectedProfit < (ctx.risk.minExpectedProfitUsd ?? 0)) {
        executionSteps.push({
          key: "polymarket_fok_retry",
          label: "Polymarket FOK retry",
          status: "halt",
          detail: `retry ${attempt} refreshed edge/profit failed (${(netAfter * 100).toFixed(2)}%, $${expectedProfit.toFixed(2)})`,
        });
        continue;
      }

      applyResizedRequests(nextRequests);
      executionSteps.push({
        key: "polymarket_fok_retry",
        label: "Polymarket FOK retry",
        status: "warn",
        detail: `retry ${attempt}: resized to ${nextSize.toFixed(4)} contracts at ${nextLimit.toFixed(2)}c limit after live book refresh`,
      });
      const retry = await placeTimed(index, attempt + 1);
      if (retry.ok && retry.filledContracts >= requests[index].sizeContracts) return retry;
      firstResult = retry;
      if (!isPolymarketFokFailure(requests[index], retry)) return retry;
    }
    return firstResult;
  };

  let placed: OrderResult[];
  if (shouldSequence) {
    placed = new Array<OrderResult>(requests.length);
    const [first, ...rest] = sequencingOrder;
    // The Polymarket anchor's book preflight already ran concurrently with the fillability
    // checks above (and applied any resize). Place the anchor directly; retryPolymarketAnchor
    // handles a thin/failed book by requoting + resizing.
    placed[first] = await placeTimed(first);
    placed[first] = await retryPolymarketAnchor(first, placed[first]);
    if (!placed[first].ok || placed[first].filledContracts < requests[first].sizeContracts) {
      const firstVenue = venueLabel(requests[first].venueId);
      const error = `not submitted because ${firstVenue} anchor leg did not fully fill: ${placed[first].error ?? placed[first].status}`;
      for (const i of rest) placed[i] = skippedBecausePriorLegFailed(requests[i], error);
    } else {
      const restResults = await Promise.all(rest.map((i) => placeTimed(i)));
      rest.forEach((i, idx) => {
        placed[i] = restResults[idx];
      });
    }
  } else {
    placed = await Promise.all(requests.map((_, i) => placeTimed(i)));
  }

  // ── Position status from the immediate venue ACKS ───────────────────────────
  // Status is derived from the acks (placed) right away. Settlement reconciliation
  // (on-chain finality) is re-queried in the BACKGROUND after this function returns — it
  // used to BLOCK the hot path up to ~4.5s (3×1500ms), throttling how many arbs we can
  // attempt. Naked exposure is still detected immediately from the acks; if reconciliation
  // later shows an ack'd fill failed to settle, the trade is corrected + a loud follow-up
  // log is written (see the background block before `return`).
  type FillClassification = {
    status: Trade["status"];
    fillStatus: Trade["fillStatus"];
    result: ExecutionOutcome["result"];
    reasonCode: ExecutionOutcome["reasonCode"];
    reason: string;
    nakedLegIndex?: number;
  };
  const classifyFills = (resultsArr: OrderResult[]): FillClassification => {
    const flags = resultsArr.map((r) => r.filledContracts > 0);
    const fully = resultsArr.every((r, i) => r.filledContracts >= activeLegs[i].size);
    if (flags.every(Boolean) && fully) {
      return { status: "open", fillStatus: "filled", result: "executed", reasonCode: null, reason: mode === "live" ? "Both legs filled (live)" : "Both legs filled (dry-run)" };
    }
    if (flags.every(Boolean)) {
      return { status: "partial", fillStatus: "partial", result: "partial", reasonCode: null, reason: "Partial fill — reduced size" };
    }
    if (flags.some(Boolean)) {
      return { status: "naked", fillStatus: "partial", result: "naked", reasonCode: "naked_position", reason: "One leg filled, the hedge did not — unhedged exposure", nakedLegIndex: flags.findIndex(Boolean) };
    }
    return { status: "failed", fillStatus: "failed", result: "halted", reasonCode: "hedge_failed", reason: resultsArr.find((r) => r.error)?.error ?? "No legs filled" };
  };

  const reconciliation: LegReconciliation[] = []; // populated by the background pass, not the hot path
  const results = placed;
  const { status, fillStatus, result, reasonCode, reason, nakedLegIndex } = classifyFills(results);
  executionSteps.push({
    key: "execute",
    label: "Leg execution",
    status: result === "executed" ? "pass" : result === "partial" ? "warn" : "halt",
    detail: reason,
  });

  // Reflect actual executed prices/sizes on the legs.
  const legs: ArbLeg[] = activeLegs.map((l, i) => {
    const r = results[i];
    const cents = r.avgPriceCents || l.priceCents;
    return { ...l, priceCents: cents, decimalOdds: 100 / cents, impliedProbability: cents / 100, size: r.filledContracts || (status === "failed" ? 0 : l.size) };
  });

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
          totalCost: activeTotalStake,
          expectedProfit: activeExpectedProfit,
          realizedPnl: null,
          netEdge: activeNetAfter,
          clvDrift: null,
          status,
          openedAt: opened,
          closedAt: null,
          date,
          nakedLegIndex,
          executionSteps,
        };

  const postFill = trade ? await verifyPostFill(ctx.opportunityId, date, activeNetAfter) : undefined;
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
    activeNetAfter,
    result === "halted" ? "halted" : result,
    reasonCode,
    reason,
    {
      effectiveMode: mode,
      gateBlockers: gate.blockers,
      tradeId: trade?.id ?? null,
      opportunityId: ctx.opportunityId,
      pipelineSteps: trade?.executionSteps ?? executionSteps,
      orders: results.map((r, i) => ({ venue: activeLegs[i].venueId, orderId: r.orderId, status: r.status, filled: r.filledContracts, error: r.error })),
      timing: ctx.timing,
      orderTimings,
      reconciliation: reconciliation.length
        ? reconciliation.map((rc) => ({ venue: rc.venue, orderId: rc.orderId, settlement: rc.confirmation?.status ?? "n/a" }))
        : undefined,
      totalCost: activeTotalStake,
      expectedProfit: activeExpectedProfit,
      postFill,
    },
    date,
    tradeMode
  );

  // ── Background settlement reconciliation (live only, off the hot path) ───────
  // Re-query venues for finality AFTER returning. If an ack'd fill failed to settle (or a
  // leg reported unfilled actually settled), correct the trade record and write a loud
  // follow-up log. This preserves the naked-exposure guarantee reconcileLegs gave — it just
  // no longer blocks the executor for ~4.5s per attempt.
  if (mode === "live" && placed.some((r) => r.orderId)) {
    void (async () => {
      try {
        const recon = await reconcileLegs(adapters, requests, placed);
        const reconciled = applyReconciliation(placed, recon);
        const changed = reconciled.some((r, i) => r.filledContracts !== placed[i].filledContracts);
        if (!changed) return;
        const corr = classifyFills(reconciled);
        const corrLegs: ArbLeg[] = activeLegs.map((l, i) => {
          const r = reconciled[i];
          const cents = r.avgPriceCents || l.priceCents;
          return { ...l, priceCents: cents, decimalOdds: 100 / cents, impliedProbability: cents / 100, size: r.filledContracts || (corr.status === "failed" ? 0 : l.size) };
        });
        // Update the existing trade in place, or create one if the immediate outcome was
        // "failed" (trade === null) but settlement revealed a real (naked) fill.
        if (trade) {
          await updateTrade(trade.id, date, { status: corr.status, fillStatus: corr.fillStatus, nakedLegIndex: corr.nakedLegIndex, legs: corrLegs, orderIds: reconciled.map((r) => r.orderId) });
        } else if (corr.status !== "failed") {
          await saveTrade({
            id: `trade-${ctx.opportunityId}-${Date.now()}`,
            mode: tradeMode,
            opportunityId: ctx.opportunityId,
            agentId: ctx.agent.id,
            matchup: ctx.opportunityMatchup,
            legs: corrLegs,
            orderIds: reconciled.map((r) => r.orderId),
            fillStatus: corr.fillStatus,
            totalCost: activeTotalStake,
            expectedProfit: activeExpectedProfit,
            realizedPnl: null,
            netEdge: activeNetAfter,
            clvDrift: null,
            status: corr.status,
            openedAt: opened,
            closedAt: null,
            date,
            nakedLegIndex: corr.nakedLegIndex,
            executionSteps,
          });
        }
        await writeLog(
          ctx.agent,
          ctx.opportunityMatchup,
          ctx.venues,
          activeNetAfter,
          corr.result === "halted" ? "halted" : corr.result,
          corr.reasonCode,
          `Settlement reconciliation corrected outcome: "${reason}" -> "${corr.reason}"`,
          {
            effectiveMode: mode,
            tradeId: trade?.id ?? null,
            opportunityId: ctx.opportunityId,
            correctedFrom: { status, fillStatus },
            correctedTo: { status: corr.status, fillStatus: corr.fillStatus },
            reconciliation: recon.map((rc) => ({ venue: rc.venue, orderId: rc.orderId, settlement: rc.confirmation?.status ?? "n/a" })),
            orders: reconciled.map((r, i) => ({ venue: activeLegs[i].venueId, orderId: r.orderId, status: r.status, filled: r.filledContracts, error: r.error })),
          },
          date,
          tradeMode
        );
      } catch (e) {
        console.error("[arbitrage/exec] background reconciliation failed:", e);
      }
    })();
  }

  return { result, reasonCode, reason, trade, mode, blockers: gate.blockers };
}
