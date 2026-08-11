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
  ExecutionStep,
  FeeBreakdown,
  NormalizedMarket,
  PostFillCheck,
  ReasonCode,
  RiskSettings,
  Trade,
} from "@/types/arbitrage";
import { getMarkets } from "./marketStore";
import { ingestTotals, refreshMarketsForOpportunity } from "./ingest";
import { matchMarkets } from "./matching";
import { detectArbs } from "./arbEngine";
import { getAgent } from "./agentStore";
import { getRiskSettings } from "./riskStore";
import { getTradesByDate, saveTrade } from "./tradeStore";
import { appendLog } from "./arbLogStore";
import { DEFAULT_AGENT } from "./seed";
import { centsToDollars, venueMinStakeScale } from "./arbMath";
import { computeFees, feeFractionOfStake } from "./feeEngine";
import { getVenues } from "./venueStore";
import { filterMarketsForAgent } from "./venueFilters";
import { dateParamToIsoDate } from "./date";

export type ExecutionOutcome = {
  result: ArbResult | "halted";
  reasonCode: ReasonCode | null;
  reason: string;
  trade: Trade | null;
};

const SLIPPAGE_RESERVE = 0; // legs priced at ask; spread already included
// The old path re-ran the FULL refresh up to 3× (retries=2), each a slow re-fetch — the
// biggest chunk of placement latency. The targeted refresh + freshness fast-path below make
// retries unnecessary: one targeted refresh (or none, when quotes are already fresh).
const LIVE_REFRESH_RETRIES = 0;
const LIVE_REFRESH_RETRY_DELAY_MS = 250;
// The scanner re-ingests every ~1s, so a just-detected opportunity's legs are usually
// fresh. When they're fresher than this (clamped to staleQuoteMs) we skip the pre-trade
// network refresh entirely and go straight to the gates — the single biggest speedup.
const LIVE_QUOTE_FRESH_MS = 2500;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function opportunityStartDate(opportunityId: string): string | null {
  const parts = opportunityId.split(":");
  if (parts.length < 2) return null;
  const maybeIso = parts[parts.length - 3];
  return /^\d{4}-\d{2}-\d{2}T/.test(maybeIso) ? maybeIso.slice(0, 10) : null;
}

// Opportunity ids append `marketType:line` to the event key. Strip those fields—and the
// optional F5 segment suffix—so the Risk panel's "Max open real per match" value counts
// every live position on the same physical game, across totals, spreads and moneylines.
export function opportunityMatchKey(opportunityId: string): string {
  const parts = opportunityId.split(":");
  const eventParts = parts.length >= 3 ? parts.slice(0, -2) : parts;
  if (eventParts.at(-1) === "f5") eventParts.pop();
  return eventParts.join(":");
}

function sourceStartDate(value: string | undefined): string | null {
  if (!value) return null;
  return value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

// Pure — no I/O — so it's directly unit-testable without mocking the store layer that
// prepareExecution otherwise requires. Re-derives each leg's game segment from the CURRENT
// market rows (not from the opportunity's own cached id/eventKey string), so a stale or
// mis-tagged opportunity can never slip through just because it was built before the check
// existed. See the "segment_consistency" gate in prepareExecution for why this exists.
export function findLegSegmentMismatch(
  legs: Pick<ArbLeg, "venueId" | "marketId">[],
  markets: Pick<NormalizedMarket, "marketId" | "segment">[]
): { mismatched: boolean; legSegments: { venueId: string; marketId: string; segment: string }[] } {
  const legSegments = legs.map((l) => {
    const m = markets.find((mk) => mk.marketId === l.marketId);
    return { venueId: l.venueId, marketId: l.marketId, segment: m?.segment ?? "full_game" };
  });
  const distinctSegments = new Set(legSegments.map((l) => l.segment));
  return { mismatched: distinctSegments.size > 1, legSegments };
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
    pair: `[AG:${agent.id}] ${matchup}`,
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
  // When an SX.bet leg forced the arb to be sized up to clear the $1 order minimum, this is
  // the resulting total stake — the gate allows it even above the configured live cap. 0 when
  // no size-up was needed.
  minLiveStakeFloorUsd: number;
  executionSteps: ExecutionStep[];
  // Same clock reference addStep's tookMs was computed against — pass this straight into
  // any further pushes (executor.ts) so the whole attempt shares one continuous timeline.
  pipelineStartMs: number;
};

export type PrepareResult =
  | { kind: "halt"; outcome: ExecutionOutcome }
  | { kind: "ready"; ctx: PreparedContext };

// Run the deterministic pre-execution checks + final quote refresh. On any failure it
// writes the halt log and returns a halt; on success it returns the prepared context.
// Shared by paper and live so both enforce the exact same safety gates.
//
// `pipelineStartMs` is the clock reference every step's tookMs is measured against —
// defaults to "now" (this call's own start) when the caller doesn't have an earlier
// reference, but executor.ts passes its own start time so the WHOLE attempt (prepare +
// place + reconcile) shares one continuous timeline instead of resetting to 0 partway
// through.
export async function prepareExecution(
  opportunityId: string,
  date: string,
  requestedMode: "dry_run" | "live" = "dry_run",
  pipelineStartMs: number = Date.now()
): Promise<PrepareResult> {
  const agent = (await getAgent(DEFAULT_AGENT.id)) ?? DEFAULT_AGENT;
  const risk: RiskSettings = await getRiskSettings();
  const configuredVenues = await getVenues();
  const executionSteps: ExecutionStep[] = [];
  const addStep = (key: string, label: string, status: ExecutionStep["status"], detail?: string) => {
    executionSteps.push({ key, label, status, detail, tookMs: Date.now() - pipelineStartMs });
  };

  const priorMatchup = opportunityId.split(":")[2] ?? opportunityId;
  const requestedSlateDate = dateParamToIsoDate(date);
  const oppDate = opportunityStartDate(opportunityId);

  // Load stored markets → matched events → opportunities, and locate this one.
  const detect = async () => {
    const markets = filterMarketsForAgent(await getMarkets(date), configuredVenues, agent);
    const { matched } = matchMarkets(markets);
    const { opportunities } = detectArbs(matched, agent, { minLiquidityUsd: risk.minLiquidityUsd, staleDivergenceCents: risk.staleDivergenceCents });
    return { markets, opp: opportunities.find((o) => o.id === opportunityId) };
  };
  // Age (ms) of the oldest quote backing the opportunity's legs.
  const legAgeMs = (o: ArbOpportunity, mkts: NormalizedMarket[]) =>
    Math.max(0, ...o.legs.map((l) => {
      const m = mkts.find((mk) => mk.marketId === l.marketId);
      if (!m) return Number.POSITIVE_INFINITY;
      const updatedAt = Date.parse(m.lastUpdated);
      return Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : Number.POSITIVE_INFINITY;
    }));

  let { markets, opp } = await detect();
  // Live orders must run on a fresh snapshot. Paper keeps the wider cache window (no fill risk).
  //
  // Fast-path: if the scanner already left this opportunity's legs fresher than
  // LIVE_QUOTE_FRESH_MS (clamped to staleQuoteMs), skip the network refresh — the stale
  // gate below still enforces freshness. Otherwise do ONE targeted refresh scoped to just
  // the arb's leg venues + market type (not every venue × every market for the game).
  const initialQuoteAgeMs = opp ? legAgeMs(opp, markets) : null;
  const legVenues = opp ? [...new Set(opp.legs.map((l) => l.venueId))] : undefined;
  const canSkipLiveRefresh =
    opp != null && initialQuoteAgeMs != null && initialQuoteAgeMs <= Math.min(risk.staleQuoteMs, LIVE_QUOTE_FRESH_MS);
  if (requestedMode === "live" && !canSkipLiveRefresh) {
    for (let attempt = 0; attempt <= LIVE_REFRESH_RETRIES; attempt += 1) {
      await refreshMarketsForOpportunity(date, opportunityId, legVenues).catch((e) => console.error("[arbitrage/exec] targeted pre-execution refresh failed:", e));
      ({ markets, opp } = await detect());
      if (opp) break;
      if (attempt < LIVE_REFRESH_RETRIES) await sleep(LIVE_REFRESH_RETRY_DELAY_MS);
    }
  } else if (requestedMode !== "live" && (!opp || legAgeMs(opp, markets) > risk.staleQuoteMs)) {
    await ingestTotals(date).catch((e) => console.error("[arbitrage/exec] pre-execution refresh failed:", e));
    ({ markets, opp } = await detect());
  }

  const asHalt = async (rc: ReasonCode, reason: string, matchup: string, venues: string[], edge: number, details: Record<string, unknown>) => {
    addStep(rc, reasonCodeLabel(rc), "halt", reason);
    const h = halt(rc, reason);
    await writeLog(agent, matchup, venues, edge, "halted", rc, reason, { ...details, opportunityId, pipelineSteps: executionSteps }, date);
    return { kind: "halt" as const, outcome: h };
  };

  addStep("cb_arb_enabled", "Agent enabled", "pass", agent.enabled ? "Agent is enabled" : "Agent is off");
  if (!agent.enabled || agent.strategy !== "arbitrage") return asHalt("agent_disabled", "Agent is off or not an arbitrage agent", priorMatchup, [], 0, { opportunityId });
  addStep("slate_date", "Slate date", oppDate == null || oppDate === requestedSlateDate ? "pass" : "halt", oppDate == null ? `requested ${requestedSlateDate}` : `opportunity ${oppDate} / requested ${requestedSlateDate}`);
  if (oppDate != null && oppDate !== requestedSlateDate) {
    return asHalt("final_refresh_failed", `Opportunity is for ${oppDate}, not requested slate ${requestedSlateDate}`, priorMatchup, [], 0, { opportunityId, opportunityDate: oppDate, requestedSlateDate });
  }
  addStep("final_refresh", "Final quote refresh", opp ? "pass" : "halt", opp ? "Opportunity survived refresh" : "Opportunity disappeared");
  if (!opp) return asHalt("final_refresh_failed", "Opportunity no longer exists after quote refresh", priorMatchup, [], 0, { opportunityId });

  const venues = [...new Set(opp.legs.map((l) => l.venueId))];
  const sourceDateMismatches = opp.legs
    .map((l) => ({ ...l, sourceDate: sourceStartDate(l.sourceStartTime) }))
    .filter((l) => l.sourceDate != null && l.sourceDate !== requestedSlateDate);
  addStep(
    "venue_source_date",
    "Venue source date",
    sourceDateMismatches.length === 0 ? "pass" : "halt",
    sourceDateMismatches.length === 0
      ? `all venue-native dates match ${requestedSlateDate}`
      : sourceDateMismatches.map((l) => `${l.venueId} ${l.sourceDate}`).join(", ")
  );
  if (sourceDateMismatches.length > 0) {
    return asHalt("final_refresh_failed", "Venue-native market date does not match requested slate", opp.matchup, venues, opp.netEdge, {
      requestedSlateDate,
      mismatches: sourceDateMismatches.map((l) => ({
        venueId: l.venueId,
        marketId: l.marketId,
        sourceStartTime: l.sourceStartTime,
      })),
    });
  }

  // Hard safety net, independent of trusting the matching engine's grouping: verify every
  // leg's underlying market actually covers the SAME game segment (full game vs F5 —
  // first-5-innings) by re-deriving it from the currently-loaded market rows, not from the
  // opportunity's cached id/eventKey string. The matching engine already guarantees this by
  // construction (it groups strictly by eventKey, which encodes segment) — this check exists
  // for the case where detection itself ran against stale/pre-fix data despite that
  // guarantee, which is exactly what produced the 2026-08-08 Astros v Padres trade
  // (Polymarket F5 total O/U 2.5 matched against Kalshi's full-game total O/U 2.5): the
  // running process was still on pre-segment-fix code when it detected that opportunity, so
  // the eventKey never got an "f5" suffix in the first place.
  const segmentCheck = findLegSegmentMismatch(opp.legs, markets);
  addStep(
    "segment_consistency",
    "Game segment consistency",
    segmentCheck.mismatched ? "halt" : "pass",
    segmentCheck.mismatched
      ? segmentCheck.legSegments.map((l) => `${l.venueId}=${l.segment}`).join(", ")
      : `all legs are ${segmentCheck.legSegments[0]?.segment ?? "full_game"}`
  );
  if (segmentCheck.mismatched) {
    return asHalt("final_refresh_failed", "Legs cover different game segments (e.g. one full-game, one first-5-innings) — not a valid hedge", opp.matchup, venues, opp.netEdge, {
      legSegments: segmentCheck.legSegments,
    });
  }

  // A targeted refresh can fail while the old opportunity remains in the date cache.
  // Enforce the configured age in live mode too: surviving detection is not evidence that
  // any venue actually returned a current executable quote.
  const oldestMs = legAgeMs(opp, markets);
  const maxQuoteAgeMs = risk.staleQuoteMs;
  const quoteIsFresh = Number.isFinite(oldestMs) && oldestMs <= maxQuoteAgeMs;
  addStep("stale_quote", "Quote freshness", quoteIsFresh ? "pass" : "halt", `${oldestMs}ms oldest quote`);
  if (!quoteIsFresh) {
    return asHalt("stale_quote", `quote age ${oldestMs}ms exceeds ${maxQuoteAgeMs}ms (venue feed not refreshing fast enough)`, opp.matchup, venues, opp.netEdge, { oldestMs, maxQuoteAgeMs });
  }

  // Real-money position cap PER PHYSICAL MATCH, using the exact persisted value controlled
  // by the Risk panel's "Max open real per match" tab. Paper positions never count.
  const todays = await getTradesByDate(date);
  const maxPer = risk.maxOpenPositions;
  const matchKey = opportunityMatchKey(opp.id);
  const openForMatch = requestedMode === "live"
    ? todays.filter(
        (t) =>
          t.mode === "live" &&
          opportunityMatchKey(t.opportunityId) === matchKey &&
          (t.status === "open" || t.status === "partial" || t.status === "naked")
      )
    : [];
  addStep(
    "position_dedup",
    "Position dedup",
    requestedMode === "live" && maxPer > 0 && openForMatch.length >= maxPer ? "halt" : "pass",
    requestedMode === "live"
      ? `${openForMatch.length}/${Math.max(maxPer, 0)} live open for this physical match`
      : "Paper tracking does not count toward the live cap"
  );
  if (requestedMode === "live" && maxPer > 0 && openForMatch.length >= maxPer) {
    return asHalt("position_dedup", `Already at ${openForMatch.length}/${maxPer} live open positions for this match`, opp.matchup, venues, opp.netEdge, { openCount: openForMatch.length, maxPer, countedMode: "live", matchKey });
  }

  const openExposure = todays
    .filter((t) => (t.status === "open" || t.status === "partial" || t.status === "naked"))
    .reduce((s, t) => s + t.totalCost, 0);
  addStep("exposure", "Exposure cap", openExposure + opp.stakePlan.totalStake <= risk.maxExposure ? "pass" : "halt", `$${(openExposure + opp.stakePlan.totalStake).toFixed(2)} / $${risk.maxExposure.toFixed(2)}`);
  if (openExposure + opp.stakePlan.totalStake > risk.maxExposure) return asHalt("exposure_exceeded", `Exposure ${(openExposure + opp.stakePlan.totalStake).toFixed(0)} > cap ${risk.maxExposure}`, opp.matchup, venues, opp.netEdge, { openExposure });

  // ── Final refresh: apply slippage, recompute net edge ───────────────────────
  const executedLegs: ArbLeg[] = opp.legs.map((l) => {
    const executedCents = slip(l.priceCents);
    return { ...l, priceCents: executedCents, decimalOdds: 100 / executedCents, impliedProbability: executedCents / 100 };
  });

  // ── Venue $1 minimum order: size the WHOLE arb up so every min-venue leg clears its floor ──
  // A below-minimum SX.bet or Polymarket order cannot be placed at all, so this floor
  // can raise the agent's target size but never the risk live-stake cap. Scaling every leg
  // by the same factor preserves the hedge
  // ratio and edge% — see venueMinStakeScale. Example: Polymarket ~$3 / SX ~$0.68 → SX is
  // bumped to $1.01 and Polymarket scales with it (~$4.5) so the arb still holds. This runs
  // BEFORE totalStake/expectedProfit are computed below, so the risk.minExpectedProfitUsd
  // gate evaluates the trade at its ACTUAL (possibly resized) execution size, not the
  // original detected size.
  let minLiveStakeFloorUsd = 0;
  const { scale: minVenueScale, floorTotalUsd } = venueMinStakeScale(executedLegs);
  if (minVenueScale > 1) {
    executedLegs.forEach((l) => (l.size = round(l.size * minVenueScale, 4)));
    minLiveStakeFloorUsd = floorTotalUsd;
    addStep(
      "venue_min_order",
      "Venue minimum order size",
      "warn",
      `sized arb up ${minVenueScale.toFixed(2)}x so every leg clears the shared $1.01 minimum; live risk cap still applies`
    );
  }

  const execTotalCents = executedLegs.reduce((s, l) => s + l.priceCents, 0);
  const grossAfter = (100 - execTotalCents) / execTotalCents;
  const legSizes: Record<string, number> = {};
  for (const l of executedLegs) legSizes[l.venueId] = centsToDollars(l.priceCents) * l.size;
  const fees = computeFees(executedLegs);
  executedLegs.forEach((l, i) => (l.feeCents = fees[i].feeCents));
  const feeFrac = feeFractionOfStake(fees, legSizes);
  const netAfter = round(grossAfter - feeFrac - SLIPPAGE_RESERVE, 6);

  addStep("min_edge", "Minimum edge", netAfter >= agent.minEdge ? "pass" : "halt", `${(netAfter * 100).toFixed(2)}% after refresh`);
  if (netAfter < agent.minEdge) return asHalt("final_refresh_failed", `Edge collapsed to ${(netAfter * 100).toFixed(2)}% after slippage`, opp.matchup, venues, netAfter, { grossAfter, netAfter });

  const totalStake = round(Object.values(legSizes).reduce((s, v) => s + v, 0), 2);
  const guaranteedPayout = executedLegs[0]?.size ?? 0; // both legs buy equal contracts
  const totalFeeDollars = fees.reduce((s, f) => s + f.feeCents / 100, 0);
  const expectedProfit = round(guaranteedPayout - totalStake - totalFeeDollars, 2);
  const minExpectedProfitUsd = risk.minExpectedProfitUsd ?? 0;
  addStep("expected_profit", "Expected profit", expectedProfit >= minExpectedProfitUsd ? "pass" : "halt", `$${expectedProfit.toFixed(2)} / $${minExpectedProfitUsd.toFixed(2)} min`);
  if (expectedProfit < minExpectedProfitUsd) {
    return asHalt(
      "final_refresh_failed",
      `Expected profit $${expectedProfit.toFixed(2)} below min $${minExpectedProfitUsd.toFixed(2)} after refresh`,
      opp.matchup,
      venues,
      netAfter,
      { expectedProfit, minExpectedProfitUsd }
    );
  }
  const liquidityStakeBufferMultiple = Math.max(1, risk.liquidityStakeBufferMultiple ?? 1);
  const pairLiquidity = Math.min(...executedLegs.map((l) => l.liquidityUsd ?? 0));
  const requiredLiquidityUsd = Math.max(risk.minLiquidityUsd, totalStake * liquidityStakeBufferMultiple);
  addStep("min_depth", "Executable depth", pairLiquidity >= requiredLiquidityUsd ? "pass" : "halt", `$${pairLiquidity.toFixed(0)} / $${requiredLiquidityUsd.toFixed(0)} required`);
  if (pairLiquidity < requiredLiquidityUsd) {
    return asHalt(
      "insufficient_depth",
      `Executable liquidity $${pairLiquidity.toFixed(0)} below required $${requiredLiquidityUsd.toFixed(0)} (${liquidityStakeBufferMultiple}x stake buffer)`,
      opp.matchup,
      venues,
      netAfter,
      { pairLiquidity, requiredLiquidityUsd, liquidityStakeBufferMultiple }
    );
  }

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
      minLiveStakeFloorUsd,
      executionSteps,
      pipelineStartMs,
    },
  };
}

function reasonCodeLabel(code: ReasonCode): string {
  return code.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

export async function verifyPostFill(opportunityId: string, date: string, entryNetEdge: number): Promise<PostFillCheck> {
  const checkedAt = nowIso();
  try {
    const agent = (await getAgent(DEFAULT_AGENT.id)) ?? DEFAULT_AGENT;
    const risk = await getRiskSettings();
    const configuredVenues = await getVenues();
    const markets = filterMarketsForAgent(await getMarkets(date), configuredVenues, agent);
    const { matched } = matchMarkets(markets);
    const { opportunities } = detectArbs(matched, agent, { minLiquidityUsd: risk.minLiquidityUsd, staleDivergenceCents: risk.staleDivergenceCents });
    const same = opportunities.find((o) => o.id === opportunityId);
    if (!same) {
      return {
        checkedAt,
        status: "arb_gone",
        remainingNetEdge: null,
        edgeDrift: null,
        reason: "Post-fill scan did not find the same executable arb",
      };
    }
    const edgeDrift = round(same.netEdge - entryNetEdge, 6);
    return {
      checkedAt,
      status: "edge_intact",
      remainingNetEdge: same.netEdge,
      edgeDrift,
      reason: `Same arb still detected at ${(same.netEdge * 100).toFixed(2)}% net edge`,
    };
  } catch (error) {
    return {
      checkedAt,
      status: "not_checked",
      remainingNetEdge: null,
      edgeDrift: null,
      reason: String(error),
    };
  }
}

// Legacy simulated executor (paper). Kept for compatibility; the trades route now
// runs execution/executor.ts (which handles both dry-run and live via adapters).
export async function runPaperExecution(opportunityId: string, date: string): Promise<ExecutionOutcome> {
  const prep = await prepareExecution(opportunityId, date, "dry_run");
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
