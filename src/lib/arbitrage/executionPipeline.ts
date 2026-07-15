// Execution pipeline (manual §10-§13). Deterministic pre-execution checks and final
// quote refresh are shared by paper and live through `prepareExecution`. The executor
// routes each leg through a venue adapter and records a stable reason code.

import crypto from "node:crypto";
import type {
  Agent,
  ArbLeg,
  ArbLog,
  ArbResult,
  FeeBreakdown,
  ReasonCode,
  RiskSettings,
  Trade,
} from "@/types/arbitrage";
import { getMarkets } from "./marketStore";
import { matchMarkets } from "./matching";
import { detectArbs } from "./arbEngine";
import { getAgent } from "./agentStore";
import { getRiskSettings } from "./riskStore";
import { getTradesByDate } from "./tradeStore";
import { appendLog } from "./arbLogStore";
import { getVenues } from "./venueStore";
import { DEFAULT_AGENT } from "./seed";
import { centsToDollars } from "./arbMath";
import { computeFees, feeFractionOfStake } from "./feeEngine";
import { QuoteRefreshError, refreshLegQuotes } from "./quoteRefresh";
import { checkPortfolioRisk } from "./riskGuards";

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
    id: `log-${date}-${crypto.randomUUID()}`,
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
export async function prepareExecution(
  opportunityId: string,
  date: string,
  requestedMode: "dry_run" | "live" = "dry_run"
): Promise<PrepareResult> {
  const [storedAgent, risk, venueSettings] = await Promise.all([
    getAgent(DEFAULT_AGENT.id),
    getRiskSettings(),
    getVenues(),
  ]);
  const agent = storedAgent ?? DEFAULT_AGENT;

  const markets = await getMarkets(date);
  const { matched } = matchMarkets(markets);
  const { opportunities } = detectArbs(matched, agent, risk.minLiquidityUsd);
  const opp = opportunities.find((o) => o.id === opportunityId);
  const priorMatchup = opportunityId.split(":")[2] ?? opportunityId;

  const asHalt = async (rc: ReasonCode, reason: string, matchup: string, venues: string[], edge: number, details: Record<string, unknown>) => {
    const h = halt(rc, reason);
    await writeLog(agent, matchup, venues, edge, "halted", rc, reason, details, date, requestedMode === "live" ? "live" : "paper");
    return { kind: "halt" as const, outcome: h };
  };

  if (!agent.enabled || agent.strategy !== "arbitrage") return asHalt("agent_disabled", "Agent is off or not an arbitrage agent", priorMatchup, [], 0, { opportunityId });
  if (requestedMode === "live" && (!agent.live || agent.paper)) return asHalt("agent_disabled", "Agent is not armed for live execution", priorMatchup, [], 0, { opportunityId });
  if (risk.killSwitch) return asHalt("kill_switch", "Risk kill switch is active", priorMatchup, [], 0, { opportunityId });
  if (!opp) return asHalt("final_refresh_failed", "Opportunity no longer exists after quote refresh", priorMatchup, ["kalshi", "polymarket"], 0, { opportunityId });

  const venues = [...new Set(opp.legs.map((l) => l.venueId))];
  const disallowed = venues.filter((venue) => !agent.venues.includes(venue));
  if (disallowed.length > 0) return asHalt("venue_view_only", `Agent does not allow ${disallowed.join(", ")}`, opp.matchup, venues, opp.netEdge, { disallowed });
  const configured = venueSettings.filter((venue) => venues.includes(venue.id));
  const disabled = venues.filter((venue) => !configured.some((setting) => setting.id === venue && setting.enabled && setting.status !== "disabled"));
  if (disabled.length > 0) return asHalt("venue_view_only", `Venue is disabled: ${disabled.join(", ")}`, opp.matchup, venues, opp.netEdge, { disabled });
  const viewOnly = requestedMode === "live" ? configured.filter((venue) => venue.viewOnly).map((venue) => venue.id) : [];
  if (viewOnly.length > 0) return asHalt("venue_view_only", `Venue is view-only: ${viewOnly.join(", ")}`, opp.matchup, venues, opp.netEdge, { viewOnly });

  const oldestMs = Math.max(
    0,
    ...opp.legs.map((l) => {
      const m = markets.find((mk) => mk.marketId === l.marketId);
      return m ? Date.now() - Date.parse(m.lastUpdated) : 0;
    })
  );
  if (oldestMs > risk.staleQuoteMs) return asHalt("stale_quote", `Quote age ${oldestMs}ms exceeds ${risk.staleQuoteMs}ms`, opp.matchup, venues, opp.netEdge, { oldestMs });

  const todays = await getTradesByDate(date);
  const openForEvent = todays.find(
    (t) => t.opportunityId === opp.id && (t.status === "open" || t.status === "partial" || t.status === "naked")
  );
  if (openForEvent) return asHalt("position_dedup", "Already tracking this match + line + agent (max=1, open=1)", opp.matchup, venues, opp.netEdge, { existingTrade: openForEvent.id });
  const riskDecision = checkPortfolioRisk(risk, todays, opp);
  if (riskDecision) return asHalt(riskDecision.reasonCode, riskDecision.reason, opp.matchup, venues, opp.netEdge, riskDecision.details);

  // Pull both public books again and price through the full requested size.
  let executedLegs: ArbLeg[];
  try {
    executedLegs = await refreshLegQuotes(opp.legs);
  } catch (error) {
    const reasonCode = error instanceof QuoteRefreshError ? error.reasonCode : "final_refresh_failed";
    return asHalt(reasonCode, error instanceof Error ? error.message : String(error), opp.matchup, venues, opp.netEdge, {});
  }
  const execTotalCents = executedLegs.reduce((s, l) => s + l.priceCents, 0);
  const grossAfter = (100 - execTotalCents) / execTotalCents;
  const legSizes: Record<string, number> = {};
  for (const l of executedLegs) legSizes[l.venueId] = centsToDollars(l.priceCents) * l.size;
  const fees = computeFees(executedLegs);
  executedLegs.forEach((l, i) => (l.feeCents = fees[i].feeCents));
  const feeFrac = feeFractionOfStake(fees, legSizes);
  const netAfter = round(grossAfter - feeFrac - SLIPPAGE_RESERVE, 6);

  if (execTotalCents >= 100 || netAfter < agent.minEdge || netAfter > agent.maxEdge) return asHalt("final_refresh_failed", `Refreshed edge ${(netAfter * 100).toFixed(2)}% is outside agent limits`, opp.matchup, venues, netAfter, { grossAfter, netAfter });

  const totalStake = round(Object.values(legSizes).reduce((s, v) => s + v, 0), 2);
  const guaranteedPayout = Math.min(...executedLegs.map((leg) => leg.size));
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

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
