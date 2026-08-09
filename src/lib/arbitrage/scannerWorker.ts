// Persistent background scan loop — decouples heavy compute (ingest -> match -> detect) from
// the request/response cycle AND from the browser. Runs continuously in this one long-lived
// Node process (Next.js self-hosted = one persistent process, same premise as
// polymarketLiveBook.ts / kalshiLiveBook.ts / sxbetLiveBook.ts), caching its result in
// memory. The browser (ArbitrageClient.tsx) no longer triggers ingest or recomputes
// anything — it just polls GET /api/arbitrage/scanner, a cheap read of this cache. That's
// the fix for "the UI lags every 3 seconds": the expensive work isn't happening on the
// browser's clock anymore, and multiple browser tabs/reloads share one server-side scan
// instead of each re-driving their own.
//
// A useful side effect: once started, this keeps scanning even if no browser tab is open —
// reconnecting just resumes reading the latest state instead of restarting the scan.
//
// Scope boundary: this loop does NOT fire trades. Live execution needs venue credentials,
// which this codebase deliberately keeps browser-only (localStorage, forwarded per-request —
// see venueCreds.ts) rather than persisted server-side. Moving order firing into this loop
// would require those credentials to live server-side (env vars) instead, which is a
// separate, explicit security decision for the user to make — not bundled into this change.
// For now the client still fires executions itself once it sees a qualifying opportunity
// from the cached scan result (see ArbitrageClient.tsx's fireAutoBatch).

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
import type { ArbOpportunity, MainLineWatch, MatchMapData } from "@/types/arbitrage";

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
