// Execution pipeline (manual §10-§13). The deterministic pre-execution checks + final
// quote refresh are shared by paper (dry-run) and live via `prepareExecution`. The
// simulated executor (`runPaperExecution`) fills with a random roll; the real executor
// (execution/executor.ts) routes each leg through a venue adapter. Every attempt writes
// a Trade + an ArbLog with a deterministic reason code.

import type {
  Agent,
  ArbLeg,
  ArbLog,
  ArbOpportunity,
  ArbResult,
  FeeBreakdown,
  NormalizedMarket,
  ReasonCode,
  RiskSettings,
  Trade,
} from "@/types/arbitrage";
import { getMarkets } from "./marketStore";
import { ingestTotals } from "./ingest";
import { matchMarkets } from "./matching";
import { detectArbs } from "./arbEngine";
import { getAgent } from "./agentStore";
import { getRiskSettings } from "./riskStore";
import { getTradesByDate, saveTrade } from "./tradeStore";
import { appendLog } from "./arbLogStore";
import { DEFAULT_AGENT } from "./seed";
import { centsToDollars } from "./arbMath";
import { computeFees, feeFractionOfStake } from "./feeEngine";
import { getVenues } from "./venueStore";
import { filterMarketsToEnabledVenues } from "./venueFilters";

export type ExecutionOutcome = {
  result: ArbResult | "halted";
  reasonCode: ReasonCode | null;
  reason: string;
  trade: Trade | null;
};

const SLIPPAGE_RESERVE = 0; // legs priced at ask; spread already included

function nowIso() {
  return new Date().toISOString();
}

export async function writeLog(
  agent: Agent,
  matchup: string,
  venues: string[],
  edge: number,
  result: ArbResult,
  reasonCode: ReasonCode | null,
  reason: string,
  details: Record<string, unknown>,
  date: string,
  mode: "paper" | "live" = "paper"
): Promise<ArbLog> {
  const log: ArbLog = {
    id: `log-${date}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    time: nowIso(),
    pair: `[CB:${agent.id}] ${matchup}`,
    venues,
    edge,
    mode,
    agent: agent.id,
    result,
    reasonCode,
    reason,
    detailsJson: details,
    date,
  };
  await appendLog(log).catch((e) => console.error("[arbitrage/exec] log write failed:", e));
  return log;
}

function halt(reasonCode: ReasonCode, reason: string): ExecutionOutcome {
  return { result: "halted", reasonCode, reason, trade: null };
}

// Residual adverse move at "final refresh" (0-1c) — top-of-book cost is already in
// the ask; this models a small depth walk between detection and fill.
function slip(cents: number): number {
  return Math.min(99, cents + Math.round(Math.random()));
}

// Everything a fill needs after the checks pass: the refreshed legs, sizing, fees.
export type PreparedContext = {
  agent: Agent;
  risk: RiskSettings;
  opportunityId: string;
  opportunityMatchup: string;
  venues: string[];
  executedLegs: ArbLeg[];
  legSizes: Record<string, number>;
  fees: FeeBreakdown[];
  totalStake: number;
  guaranteedPayout: number;
  expectedProfit: number;
  netAfter: number;
};

export type PrepareResult =
  | { kind: "halt"; outcome: ExecutionOutcome }
  | { kind: "ready"; ctx: PreparedContext };

// Run the deterministic pre-execution checks + final quote refresh. On any failure it
// writes the halt log and returns a halt; on success it returns the prepared context.
// Shared by paper and live so both enforce the exact same safety gates.
export async function prepareExecution(opportunityId: string, date: string): Promise<PrepareResult> {
  const agent = (await getAgent(DEFAULT_AGENT.id)) ?? DEFAULT_AGENT;
  const risk: RiskSettings = await getRiskSettings();
  const configuredVenues = await getVenues();

  const priorMatchup = opportunityId.split(":")[2] ?? opportunityId;

  // Load stored markets → matched events → opportunities, and locate this one.
  const detect = async () => {
    const markets = filterMarketsToEnabledVenues(await getMarkets(date), configuredVenues);
    const { matched } = matchMarkets(markets);
    const { opportunities } = detectArbs(matched, agent, risk.minLiquidityUsd);
    return { markets, opp: opportunities.find((o) => o.id === opportunityId) };
  };
  // Age (ms) of the oldest quote backing the opportunity's legs.
  const legAgeMs = (o: ArbOpportunity, mkts: NormalizedMarket[]) =>
    Math.max(0, ...o.legs.map((l) => {
      const m = mkts.find((mk) => mk.marketId === l.marketId);
      return m ? Date.now() - Date.parse(m.lastUpdated) : 0;
    }));

  let { markets, opp } = await detect();
  // Refresh stale quotes ONCE before executing so a real order fires on current prices,
  // not the last scan. (Without this, execution silently depended on the scanner running.)
  if (!opp || legAgeMs(opp, markets) > risk.staleQuoteMs) {
    await ingestTotals(date).catch((e) => console.error("[arbitrage/exec] pre-execution refresh failed:", e));
    ({ markets, opp } = await detect());
  }

  const asHalt = async (rc: ReasonCode, reason: string, matchup: string, venues: string[], edge: number, details: Record<string, unknown>) => {
    const h = halt(rc, reason);
    await writeLog(agent, matchup, venues, edge, "halted", rc, reason, details, date);
    return { kind: "halt" as const, outcome: h };
  };

  if (!agent.enabled || agent.strategy !== "arbitrage") return asHalt("agent_disabled", "Agent is off or not an arbitrage agent", priorMatchup, [], 0, { opportunityId });
  if (risk.killSwitch) return asHalt("kill_switch", "Risk kill switch is active", priorMatchup, [], 0, { opportunityId });
  if (!opp) return asHalt("final_refresh_failed", "Opportunity no longer exists after quote refresh", priorMatchup, [], 0, { opportunityId });

  const venues = [...new Set(opp.legs.map((l) => l.venueId))];

  // Still stale after a fresh re-ingest ⇒ the venue feeds themselves aren't updating.
  const oldestMs = legAgeMs(opp, markets);
  if (oldestMs > risk.staleQuoteMs) return asHalt("stale_quote", `Quote age ${oldestMs}ms exceeds ${risk.staleQuoteMs}ms (venue feed not refreshing)`, opp.matchup, venues, opp.netEdge, { oldestMs });

  // Position cap PER opportunity (match + line + market). risk.maxOpenPositions is the
  // number of concurrent open positions allowed on the same arb; <= 0 means unlimited, so
  // you can re-enter as long as the edge/depth checks above still pass on fresh quotes.
  const todays = await getTradesByDate(date);
  const openForEvent = todays.filter(
    (t) => t.opportunityId === opp.id && (t.status === "open" || t.status === "partial" || t.status === "naked")
  );
  const maxPer = risk.maxOpenPositions;
  if (maxPer > 0 && openForEvent.length >= maxPer) {
    return asHalt("position_dedup", `Already at ${openForEvent.length}/${maxPer} open positions for this match + line`, opp.matchup, venues, opp.netEdge, { openCount: openForEvent.length, maxPer });
  }

  const openExposure = todays
    .filter((t) => (t.status === "open" || t.status === "partial" || t.status === "naked"))
    .reduce((s, t) => s + t.totalCost, 0);
  if (openExposure + opp.stakePlan.totalStake > risk.maxExposure) return asHalt("exposure_exceeded", `Exposure ${(openExposure + opp.stakePlan.totalStake).toFixed(0)} > cap ${risk.maxExposure}`, opp.matchup, venues, opp.netEdge, { openExposure });

  // ── Final refresh: apply slippage, recompute net edge ───────────────────────
  const executedLegs: ArbLeg[] = opp.legs.map((l) => {
    const executedCents = slip(l.priceCents);
    return { ...l, priceCents: executedCents, decimalOdds: 100 / executedCents, impliedProbability: executedCents / 100 };
  });
  const execTotalCents = executedLegs.reduce((s, l) => s + l.priceCents, 0);
  const grossAfter = (100 - execTotalCents) / execTotalCents;
  const legSizes: Record<string, number> = {};
  for (const l of executedLegs) legSizes[l.venueId] = centsToDollars(l.priceCents) * l.size;
  const fees = computeFees(executedLegs);
  executedLegs.forEach((l, i) => (l.feeCents = fees[i].feeCents));
  const feeFrac = feeFractionOfStake(fees, legSizes);
  const netAfter = round(grossAfter - feeFrac - SLIPPAGE_RESERVE, 6);

  if (netAfter < agent.minEdge) return asHalt("final_refresh_failed", `Edge collapsed to ${(netAfter * 100).toFixed(2)}% after slippage`, opp.matchup, venues, netAfter, { grossAfter, netAfter });

  const totalStake = round(Object.values(legSizes).reduce((s, v) => s + v, 0), 2);
  const guaranteedPayout = executedLegs[0]?.size ?? 0; // both legs buy equal contracts
  const totalFeeDollars = fees.reduce((s, f) => s + f.feeCents / 100, 0);
  const expectedProfit = round(guaranteedPayout - totalStake - totalFeeDollars, 2);

  return {
    kind: "ready",
    ctx: {
      agent,
      risk,
      opportunityId: opp.id,
      opportunityMatchup: opp.matchup,
      venues,
      executedLegs,
      legSizes,
      fees,
      totalStake,
      guaranteedPayout,
      expectedProfit,
      netAfter,
    },
  };
}

// Legacy simulated executor (paper). Kept for compatibility; the trades route now
// runs execution/executor.ts (which handles both dry-run and live via adapters).
export async function runPaperExecution(opportunityId: string, date: string): Promise<ExecutionOutcome> {
  const prep = await prepareExecution(opportunityId, date);
  if (prep.kind === "halt") return prep.outcome;
  const { agent, opportunityId: oppId, opportunityMatchup, venues, executedLegs, fees, totalStake, expectedProfit, netAfter } = prep.ctx;

  const roll = Math.random();
  let status: Trade["status"];
  let fillStatus: Trade["fillStatus"];
  let result: ArbResult;
  let reasonCode: ReasonCode | null = null;
  let reason: string;
  let nakedLegIndex: number | undefined;

  if (roll < 0.06) {
    status = "naked";
    fillStatus = "partial";
    result = "naked";
    reasonCode = "naked_position";
    reason = "One leg filled, hedge failed — unhedged exposure (paper)";
    nakedLegIndex = Math.random() < 0.5 ? 0 : 1;
  } else if (roll < 0.12) {
    status = "partial";
    fillStatus = "partial";
    result = "partial";
    reason = "Partial fill — reduced size (paper)";
  } else {
    status = "open";
    fillStatus = "filled";
    result = "executed";
    reason = "Both legs filled (paper)";
  }

  const opened = nowIso();
  const trade: Trade = {
    id: `trade-${oppId}-${Date.now()}`,
    mode: "paper",
    opportunityId: oppId,
    agentId: agent.id,
    matchup: opportunityMatchup,
    legs: executedLegs,
    orderIds: executedLegs.map((_, i) => `paper-${Date.now()}-${i}`),
    fillStatus,
    totalCost: totalStake,
    expectedProfit,
    realizedPnl: null,
    netEdge: netAfter,
    clvDrift: null,
    status,
    openedAt: opened,
    closedAt: null,
    date,
    nakedLegIndex,
  };
  await saveTrade(trade);
  await writeLog(agent, opportunityMatchup, venues, netAfter, result, reasonCode, reason, {
    executedCents: executedLegs.map((l) => l.priceCents),
    totalCost: totalStake,
    expectedProfit,
    fees: fees.map((f) => ({ venue: f.venueId, feeCents: f.feeCents })),
  }, date);

  return { result, reasonCode, reason, trade };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Settle a paper position — guaranteed arbs realize their expected profit; naked
// positions are marked resolved at the modeled expectation (no hedge protection).
export function settledPnl(trade: Trade): number {
  if (trade.status === "naked") return round(-Math.abs(trade.expectedProfit) * 0.5, 2);
  return trade.expectedProfit;
}
