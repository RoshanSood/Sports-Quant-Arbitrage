// Persistent background scan loop — decouples heavy compute (ingest -> match -> detect) from
// the request/response cycle AND from the browser. Runs continuously in this one long-lived
// Node process (Next.js self-hosted = one persistent process, same premise as
// polymarketLiveBook.ts / kalshiLiveBook.ts / sxbetLiveBook.ts), caching its result in
// memory. The browser (ArbitrageClient.tsx) no longer triggers ingest or recomputes
// anything — it just polls GET /api/arbitrage/scanner, a cheap read of this cache, purely
// for display. That's the fix for "the UI lags every 3 seconds": the expensive work isn't
// happening on the browser's clock anymore, and multiple browser tabs/reloads share one
// server-side scan instead of each re-driving their own.
//
// A useful side effect: once started, this keeps scanning even if no browser tab is open —
// reconnecting just resumes reading the latest state instead of restarting the scan.
//
// This loop ALSO fires trades directly, immediately after detectArbs() — no browser round
// trip. Live execution needs venue credentials; every adapter's credential resolver already
// falls back to server env vars when no per-request creds are forwarded (kalshiAuth.ts,
// wallet.ts, predictFunAdapter.ts), and those env vars are configured for every venue, so
// there's no new credential plumbing here. This is a deliberate change from the earlier
// design (where the browser's fireAutoBatch fired trades once it saw a qualifying
// opportunity in the polled snapshot): firing here removes both the ~800ms poll interval
// and the trade's dependency on a browser tab being open at all. Trades now run 24/7
// whenever the agent has autoTrade on, whether or not anyone is looking at the UI — the
// browser-side auto-fire was removed to avoid two independent triggers racing the same
// opportunity (see ArbitrageClient.tsx).
//
// Firing is NOT awaited here — runExecution's own serializeLiveExecution queue already
// ensures live trades run one at a time server-side, so kicking them all off immediately
// lets that queue do the ordering while this tick moves on to schedule the next scan
// without waiting on trade completion.

import { pacificTodayDateStr } from "./date";
import { ingestTotals } from "./ingest";
import { getMarkets } from "./marketStore";
import { matchMarkets } from "./matching";
import { detectArbs, type ArbReject } from "./arbEngine";
import { getAgent } from "./agentStore";
import { getRiskSettings } from "./riskStore";
import { getVenues } from "./venueStore";
import { filterMarketsForAgent } from "./venueFilters";
import { DEFAULT_AGENT } from "./seed";
import { runExecution } from "./execution/executor";
import type { Agent, ArbOpportunity, MainLineWatch, MatchMapData } from "@/types/arbitrage";

// Floor between completed scan cycles (mirrors the prior client-side SCAN_MIN_GAP_MS) — each
// cycle re-ingests every venue, so this just prevents a busy-loop if a cycle finishes fast.
const SCAN_MIN_GAP_MS = 1000;

export type ScannerStatus = {
  scanning: boolean;
  date: string;
  startedAt: number; // generation boundary; results older than this run are invalid
  updatedAt: number; // 0 = no scan has completed yet
  opportunities: ArbOpportunity[];
  rejects: ArbReject[];
  watch: MainLineWatch[];
  matchMap: MatchMapData;
  error: string | null;
};

const EMPTY_MATCH_MAP: MatchMapData = {
  matched: [],
  rejects: [],
  stats: { matched: 0, byVenue: {}, byVenuePair: {}, dedupDropped: 0, selfEdgeDropped: 0, lineMismatch: 0, invariantRejected: 0 },
};

let scanning = false;
let looping = false;
let scanGeneration = 0;
let status: ScannerStatus = {
  scanning: false,
  date: pacificTodayDateStr(),
  startedAt: 0,
  updatedAt: 0,
  opportunities: [],
  rejects: [],
  watch: [],
  matchMap: EMPTY_MATCH_MAP,
  error: null,
};

// Ids currently being placed — prevents firing the SAME opportunity twice concurrently
// while a placement is in flight. Deliberately NOT a permanent "already fired" set: a
// failed/halted attempt (arb momentarily vanished, thin depth, a stale quote) leaves it
// eligible, so it keeps getting retried on the next tick that still detects it. Mirrors
// the browser's old autoInFlightRef, now living here since this is the sole trigger.
const autoInFlight = new Set<string>();

// Fire every currently-detected opportunity that isn't already being placed, the instant
// detectArbs() returns them — no browser round trip. Deliberately NOT awaited by the
// caller: runExecution's own serializeLiveExecution queue serializes live trades across
// the whole process, so kicking every eligible id off immediately lets that queue do the
// ordering while this tick moves on to scheduling the next scan.
function fireAutoTrades(opportunities: ArbOpportunity[], agent: Agent, date: string): void {
  if (!agent.autoTrade) return;
  const mode = agent.live ? "live" : "dry_run";
  for (const opp of opportunities) {
    if (autoInFlight.has(opp.id)) continue;
    autoInFlight.add(opp.id);
    runExecution(opp.id, date, mode, undefined, opp.detectedAt)
      .catch((e) => console.error(`[scannerWorker] auto-trade execution failed for ${opp.id}:`, e))
      .finally(() => autoInFlight.delete(opp.id));
  }
}

// One scan cycle: ingest (already parallelized across venues + F5-aware + live-book-
// augmented, see ingest.ts) then the SAME match+detect computation the old per-request
// /api/arbitrage/opportunities route used to run on every single GET.
async function tick(generation: number): Promise<void> {
  const date = pacificTodayDateStr();
  await ingestTotals(date);

  const [markets, agent, risk, venues] = await Promise.all([
    getMarkets(date),
    getAgent(DEFAULT_AGENT.id).then((a) => a ?? DEFAULT_AGENT),
    getRiskSettings(),
    getVenues(),
  ]);
  const activeMarkets = filterMarketsForAgent(markets, venues, agent);
  const matchMap = matchMarkets(activeMarkets);
  const { opportunities, rejects, watch } = detectArbs(matchMap.matched, agent, {
    minLiquidityUsd: risk.minLiquidityUsd,
    staleDivergenceCents: risk.staleDivergenceCents,
  });

  // A stop/start may have occurred while venue requests were in flight. Never publish that
  // prior generation's completed computation into the new generation's empty cache.
  if (scanning && generation === scanGeneration) {
    fireAutoTrades(opportunities, agent, date);
    status = { ...status, scanning: true, date, updatedAt: Date.now(), opportunities, rejects, watch, matchMap, error: null };
  }
}

async function loop(): Promise<void> {
  if (looping) return;
  looping = true;
  try {
    while (scanning) {
      const generation = scanGeneration;
      const startedAt = Date.now();
      try {
        await tick(generation);
      } catch (e) {
        console.error("[scannerWorker] tick failed:", e);
        if (generation === scanGeneration) status = { ...status, error: String(e) };
      }
      const elapsed = Date.now() - startedAt;
      if (scanning) await new Promise((r) => setTimeout(r, Math.max(0, SCAN_MIN_GAP_MS - elapsed)));
    }
  } finally {
    looping = false;
  }
}

export function startScanning(): void {
  if (scanning) return;
  scanning = true;
  scanGeneration += 1;
  // A restart is a new scan generation. Never expose opportunities computed before it.
  status = {
    scanning: true,
    date: pacificTodayDateStr(),
    startedAt: Date.now(),
    updatedAt: 0,
    opportunities: [],
    rejects: [],
    watch: [],
    matchMap: EMPTY_MATCH_MAP,
    error: null,
  };
  loop();
}

export function stopScanning(): void {
  scanning = false;
  scanGeneration += 1;
  // Clear actionable rows immediately. A scan already in flight may finish afterward, but
  // tick preserves scanning=false and the client also rejects non-scanning snapshots.
  status = { ...status, scanning: false, opportunities: [], watch: [] };
}

export function getScannerStatus(): ScannerStatus {
  return status;
}
