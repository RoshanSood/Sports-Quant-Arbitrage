import type { ArbLeg, ArbResult, FillStatus, ReasonCode, Trade, TradeStatus } from "@/types/arbitrage";
import { computeFees } from "../feeEngine";
import { prepareExecution, writeLog, type ExecutionOutcome } from "../executionPipeline";
import { updateRiskSettings } from "../riskStore";
import { saveTrade } from "../tradeStore";
import { resolveExecutionMode, type ExecMode } from "./config";
import { getAdapter, venueSupportsLive, type ExecCreds } from "./registry";
import type { OrderResult } from "./types";

type FillSummary = {
  legs: ArbLeg[];
  status: TradeStatus;
  fillStatus: FillStatus;
  result: ArbResult | "halted";
  reasonCode: ReasonCode | null;
  reason: string;
  nakedLegIndex?: number;
  totalCost: number;
  expectedProfit: number;
  netEdge: number;
};

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function summarizeFills(planned: ArbLeg[], results: OrderResult[]): FillSummary {
  const legs = planned.map((leg, index) => {
    const fill = results[index];
    const size = Math.max(0, fill?.filledContracts ?? 0);
    const priceCents = size > 0 && fill?.avgPriceCents ? fill.avgPriceCents : leg.priceCents;
    return {
      ...leg,
      size,
      priceCents,
      decimalOdds: priceCents > 0 ? 100 / priceCents : 0,
      impliedProbability: priceCents / 100,
      feeCents: 0,
    };
  });
  const fees = computeFees(legs);
  legs.forEach((leg, index) => (leg.feeCents = fees[index].feeCents));

  const sizes = legs.map((leg) => leg.size);
  const anyFilled = sizes.some((size) => size > 0);
  const everyFilled = sizes.every((size) => size > 0);
  const matchedSize = everyFilled ? Math.min(...sizes) : 0;
  const totalCost = round(legs.reduce((sum, leg) => sum + (leg.size * leg.priceCents) / 100, 0), 4);
  const totalFees = fees.reduce((sum, fee) => sum + fee.feeCents / 100, 0);
  // This is the guaranteed floor; unmatched contracts are assumed to lose.
  const expectedProfit = round(matchedSize - totalCost - totalFees, 4);
  const netEdge = totalCost > 0 ? round(expectedProfit / totalCost, 6) : 0;

  if (!anyFilled) {
    return {
      legs,
      status: "failed",
      fillStatus: "failed",
      result: "halted",
      reasonCode: "hedge_failed",
      reason: results.find((result) => result?.error)?.error ?? "No legs filled",
      totalCost,
      expectedProfit,
      netEdge,
    };
  }

  const filledIndexes = sizes.map((size, index) => (size > 0 ? index : -1)).filter((index) => index >= 0);
  if (!everyFilled) {
    return {
      legs,
      status: "naked",
      fillStatus: "partial",
      result: "naked",
      reasonCode: "naked_position",
      reason: "One leg filled and the hedge did not",
      nakedLegIndex: filledIndexes.length === 1 ? filledIndexes[0] : undefined,
      totalCost,
      expectedProfit,
      netEdge,
    };
  }

  const equalSizes = sizes.every((size) => Math.abs(size - sizes[0]) < 1e-9);
  const fullyFilled = equalSizes && sizes.every((size, index) => size >= planned[index].size);
  if (fullyFilled) {
    return {
      legs,
      status: "open",
      fillStatus: "filled",
      result: "executed",
      reasonCode: null,
      reason: "Both fill-or-kill legs filled",
      totalCost,
      expectedProfit,
      netEdge,
    };
  }

  return {
    legs,
    status: "partial",
    fillStatus: "partial",
    result: "partial",
    reasonCode: equalSizes ? null : "naked_position",
    reason: equalSizes ? "Both legs filled at a reduced matched size" : "Leg sizes differ; unmatched exposure remains",
    totalCost,
    expectedProfit,
    netEdge,
  };
}
function unattempted(leg: ArbLeg): OrderResult {
  return {
    ok: false,
    orderId: null,
    filledContracts: 0,
    avgPriceCents: leg.priceCents,
    status: "unfilled",
    error: "Not attempted after an earlier leg failed",
  };
}

function breakEvenHedgeLimit(first: ArbLeg, hedge: ArbLeg): number {
  for (let cents = 99; cents >= hedge.priceCents; cents -= 0.01) {
    const candidate = { ...hedge, priceCents: cents, impliedProbability: cents / 100 };
    const fees = computeFees([first, candidate]).reduce((sum, fee) => sum + fee.feeCents / 100, 0);
    const profit = first.size - (first.size * first.priceCents) / 100 - (candidate.size * cents) / 100 - fees;
    if (profit >= 0) return round(cents, 2);
  }
  return hedge.priceCents;
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

  const gate = resolveExecutionMode({
    requestedMode,
    agentPaper: ctx.agent.paper,
    killSwitch: ctx.risk.killSwitch,
    venues: ctx.venues,
    stakeUsd: ctx.totalStake,
    venuesSupportLive: venueSupportsLive(ctx.venues, creds),
  });
  if (requestedMode === "live" && gate.mode !== "live") {
    const reason = `Live execution blocked: ${gate.blockers.join("; ")}`;
    await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "venue_view_only", reason, { gateBlockers: gate.blockers }, date, "live");
    return { result: "halted", reasonCode: "venue_view_only", reason, trade: null, mode: "dry_run", blockers: gate.blockers };
  }
  const mode = gate.mode;

  if (mode === "live") {
    for (const venue of ctx.venues) {
      const required = (ctx.legSizes[venue] ?? 0) + ctx.fees.filter((fee) => fee.venueId === venue).reduce((sum, fee) => sum + fee.feeCents / 100, 0);
      const balance = await getAdapter(venue, mode, creds).getBalanceUsd();
      if (balance == null || balance < required) {
        const reason = balance == null ? `${venue} balance could not be verified` : `${venue} balance ${balance.toFixed(2)} < required ${required.toFixed(2)}`;
        await writeLog(ctx.agent, ctx.opportunityMatchup, ctx.venues, ctx.netAfter, "halted", "insufficient_balance", reason, { venue, balance, required }, date, "live");
        return { result: "halted", reasonCode: "insufficient_balance", reason, trade: null, mode, blockers: [] };
      }
    }
  }

  const results = ctx.executedLegs.map(unattempted);
  const order = ctx.executedLegs
    .map((leg, index) => ({ leg, index }))
    .sort((a, b) => (a.leg.liquidityUsd ?? 0) - (b.leg.liquidityUsd ?? 0));

  for (let position = 0; position < order.length; position += 1) {
    const { leg, index } = order[position];
    const prior = position > 0 ? results[order[position - 1].index] : null;
    const sizeContracts = prior ? Math.min(leg.size, prior.filledContracts) : leg.size;
    if (sizeContracts <= 0) break;
    const adapter = getAdapter(leg.venueId, mode, creds);
    const request = {
      venueId: leg.venueId,
      marketId: leg.marketId,
      nativeMarketId: leg.nativeMarketId,
      nativeSide: leg.nativeSide,
      outcome: leg.outcome,
      sizeContracts,
      limitPriceCents: leg.priceCents,
    };
    let placed = await adapter.placeOrder(request);

    // A second FOK attempt may spend the remaining edge to avoid a naked first leg.
    if (mode === "live" && position > 0 && placed.filledContracts === 0 && prior && prior.filledContracts > 0) {
      const firstLeg = { ...order[position - 1].leg, size: prior.filledContracts, priceCents: prior.avgPriceCents };
      const hedgeLeg = { ...leg, size: prior.filledContracts };
      const rescueLimit = breakEvenHedgeLimit(firstLeg, hedgeLeg);
      if (rescueLimit > request.limitPriceCents) {
        placed = await adapter.placeOrder({ ...request, limitPriceCents: rescueLimit });
      }
    }
    results[index] = placed;
    if (placed.filledContracts <= 0) break;
  }

  const summary = summarizeFills(ctx.executedLegs, results);
  const openedAt = new Date().toISOString();
  const tradeMode = mode === "live" ? "live" : "paper";
  const trade: Trade | null = summary.status === "failed" ? null : {
    id: `trade-${ctx.opportunityId}-${Date.now()}`,
    mode: tradeMode,
    opportunityId: ctx.opportunityId,
    agentId: ctx.agent.id,
    matchup: ctx.opportunityMatchup,
    legs: summary.legs,
    orderIds: results.map((result) => result.orderId),
    fillStatus: summary.fillStatus,
    totalCost: summary.totalCost,
    expectedProfit: summary.expectedProfit,
    realizedPnl: null,
    netEdge: summary.netEdge,
    clvDrift: null,
    status: summary.status,
    openedAt,
    closedAt: null,
    date,
    nakedLegIndex: summary.nakedLegIndex,
  };

  if (trade) await saveTrade(trade);
  const hasUnmatchedExposure = summary.status === "naked" || (summary.status === "partial" && summary.reasonCode === "naked_position");
  if (mode === "live" && hasUnmatchedExposure && ctx.risk.pauseOnNaked) {
    await updateRiskSettings({ killSwitch: true });
  }

  await writeLog(
    ctx.agent,
    ctx.opportunityMatchup,
    ctx.venues,
    summary.netEdge,
    summary.result === "halted" ? "halted" : summary.result,
    summary.reasonCode,
    summary.reason,
    {
      effectiveMode: mode,
      orders: results.map((result, index) => ({ venue: ctx.executedLegs[index].venueId, orderId: result.orderId, status: result.status, filled: result.filledContracts, error: result.error })),
      actualCost: summary.totalCost,
      guaranteedFloor: summary.expectedProfit,
    },
    date,
    tradeMode
  );

  return {
    result: summary.result,
    reasonCode: summary.reasonCode,
    reason: summary.reason,
    trade,
    mode,
    blockers: gate.blockers,
  };
}
