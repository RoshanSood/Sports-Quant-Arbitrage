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
import { checkKalshiFillability } from "./kalshiAdapter";
import { checkSxFillability } from "./sxbetAdapter";
import { quotePolymarketFokBuy } from "./polymarketAdapter";
import { computeFees } from "../feeEngine";
import { executedEconomics } from "../arbMath";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

// Re-exported for callers/tests that reference it from the executor module.
export { SXBET_MIN_TAKER_STAKE_USD };

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
    // The SX.bet $1-minimum floor overrides the configured live cap: when an arb had to be
    // sized up so its SX leg clears $1, that (larger) stake must still be allowed to fire.
    maxLiveStakeUsd: Math.max(ctx.risk.maxLiveStakeUsd, ctx.minLiveStakeFloorUsd),
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
    const [sxBlockers, kalshiBlockers] = await Promise.all([
      liveSxFillabilityBlockers(requests),
      liveKalshiFillabilityBlockers(requests, creds),
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
  }

  let placed: OrderResult[];
  const sequencingOrder = mode === "live" ? fragileVenueFirstOrder(requests) : requests.map((_, i) => i);
  const shouldSequence = mode === "live" && shouldSequenceFragileVenuePair(requests);

  // ── Polymarket anchor preflight: size the FOK to the LIVE book so it actually fills ──
  // Polymarket is the anchor (placed first). A FOK is killed when it asks for more than the
  // book holds at our price — that's what left legs unfilled. Read the live ask depth and
  // resize the anchor (and the hedge, so both legs match) to what's fillable at <= our limit
  // (+1c cushion for small moves). If nothing is fillable at our price the arb has moved away,
  // so we leave it: the order won't fill and the hedge is skipped — no naked exposure.
  const anchorIdx = shouldSequence ? sequencingOrder[0] : -1;
  if (anchorIdx >= 0 && requests[anchorIdx].venueId === "polymarket") {
    const maxPrice = Math.min(99, requests[anchorIdx].limitPriceCents + 1);
    const quote = await quotePolymarketFokBuy(requests[anchorIdx], creds?.polymarket, maxPrice).catch(() => null);
    const nextSize = quote ? Math.floor(Math.min(requests[anchorIdx].sizeContracts, quote.availableContracts) * 1e4) / 1e4 : 0;
    // If an SX.bet leg is hedging this anchor, the resized size must still keep the SX leg at
    // or above its $1 order minimum. Shrinking below that would place a sub-$1 SX order that
    // SX rejects AFTER the Polymarket anchor already filled — a naked position. So require the
    // SX floor here: if Polymarket's book can't cover it, skip (anchor left unfilled, no naked).
    const sxHedge = requests.find((r, i) => i !== anchorIdx && r.venueId.toLowerCase().includes("sx"));
    const sxFloorContracts = sxHedge && sxHedge.limitPriceCents > 0 ? SXBET_MIN_TAKER_STAKE_USD / (sxHedge.limitPriceCents / 100) : 0;
    if (quote && nextSize > 0 && nextSize + 1e-9 >= sxFloorContracts) {
      const nextLimit = Math.min(99, Math.max(requests[anchorIdx].limitPriceCents, quote.limitPriceCents));
      requests = requests.map((r, i) => ({ ...r, sizeContracts: nextSize, limitPriceCents: i === anchorIdx ? nextLimit : r.limitPriceCents }));
      executionSteps.push({
        key: "polymarket_book_preflight",
        label: "Polymarket book preflight",
        status: "pass",
        detail: `resized to ${nextSize.toFixed(4)} fillable contracts at <= ${nextLimit.toFixed(2)}c (both legs matched)`,
      });
    } else if (quote && nextSize > 0 && sxHedge) {
      executionSteps.push({
        key: "polymarket_book_preflight",
        label: "Polymarket book preflight",
        status: "warn",
        detail: `Polymarket depth ${nextSize.toFixed(4)} ctr below SX.bet $${SXBET_MIN_TAKER_STAKE_USD.toFixed(2)} minimum (needs ${sxFloorContracts.toFixed(4)} ctr) — skipping, anchor left unfilled (no naked)`,
      });
    } else {
      executionSteps.push({
        key: "polymarket_book_preflight",
        label: "Polymarket book preflight",
        status: "warn",
        detail: `no ask depth at <= ${maxPrice.toFixed(2)}c — arb moved away, order left unfilled (hedge skipped, no naked)`,
      });
    }
  }

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
  const fullyFilled = results.every((r, i) => r.filledContracts >= ctx.executedLegs[i].size);
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
    return { ...l, priceCents: cents, decimalOdds: 100 / cents, impliedProbability: cents / 100, size: r.filledContracts || (status === "failed" ? 0 : l.size) };
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
