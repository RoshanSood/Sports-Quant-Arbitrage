// The real executor. Runs the shared pre-execution checks, resolves the effective
// mode through the safety gate (defaults to dry-run unless EVERY live switch is on),
// then places each leg through its venue adapter and records the Trade + log. Dry-run
// and live share this exact path — only the adapter differs.

import type { ArbLeg, Trade } from "@/types/arbitrage";
import { saveTrade } from "../tradeStore";
import { prepareExecution, writeLog, type ExecutionOutcome } from "../executionPipeline";
import { resolveExecutionMode, type ExecMode } from "./config";
import { getAdapter, venueSupportsLive, type ExecCreds } from "./registry";
import type { OrderResult } from "./types";

export async function runExecution(
  opportunityId: string,
  date: string,
  requestedMode: ExecMode,
  creds?: ExecCreds
): Promise<ExecutionOutcome & { mode: ExecMode; blockers: string[] }> {
  const prep = await prepareExecution(opportunityId, date);
  if (prep.kind === "halt") return { ...prep.outcome, mode: "dry_run", blockers: [] };
  const ctx = prep.ctx;

  // ── Resolve effective mode through the hard gate ────────────────────────────
  const gate = resolveExecutionMode({
    requestedMode,
    agentPaper: ctx.agent.paper,
    killSwitch: ctx.risk.killSwitch,
    venues: ctx.venues,
    stakeUsd: ctx.totalStake,
    venuesSupportLive: venueSupportsLive(ctx.venues, creds),
  });
  const mode = gate.mode;

  // ── Place each leg through its adapter ──────────────────────────────────────
  const results: OrderResult[] = [];
  for (const leg of ctx.executedLegs) {
    const adapter = getAdapter(leg.venueId, mode, creds);
    const res = await adapter.placeOrder({
      venueId: leg.venueId,
      marketId: leg.marketId,
      nativeMarketId: leg.nativeMarketId,
      nativeSide: leg.nativeSide,
      outcome: leg.outcome,
      sizeContracts: leg.size,
      limitPriceCents: leg.priceCents,
    });
    results.push(res);
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

  // Reflect actual executed prices/sizes on the legs.
  const legs: ArbLeg[] = ctx.executedLegs.map((l, i) => {
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
          totalCost: ctx.totalStake,
          expectedProfit: ctx.expectedProfit,
          realizedPnl: null,
          netEdge: ctx.netAfter,
          clvDrift: null,
          status,
          openedAt: opened,
          closedAt: null,
          date,
          nakedLegIndex,
        };

  if (trade) await saveTrade(trade);
  await writeLog(
    ctx.agent,
    ctx.opportunityMatchup,
    ctx.venues,
    ctx.netAfter,
    result === "halted" ? "halted" : result,
    reasonCode,
    reason,
    {
      effectiveMode: mode,
      gateBlockers: gate.blockers,
      orders: results.map((r, i) => ({ venue: ctx.executedLegs[i].venueId, orderId: r.orderId, status: r.status, filled: r.filledContracts, error: r.error })),
      totalCost: ctx.totalStake,
      expectedProfit: ctx.expectedProfit,
    },
    date,
    tradeMode
  );

  return { result, reasonCode, reason, trade, mode, blockers: gate.blockers };
}
