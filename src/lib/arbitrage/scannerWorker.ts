import { getAgent } from "./agentStore";
import { detectArbs } from "./arbEngine";
import { runExecution } from "./execution/executor";
import { runIngestion } from "./ingest";
import { matchMarkets } from "./matching";
import { saveOpportunities } from "./opportunityStore";
import { getRiskSettings } from "./riskStore";
import { getScannerHealth, updateScannerHealth } from "./scannerStore";
import { DEFAULT_AGENT } from "./seed";
import { getVenues } from "./venueStore";
import { filterMarketsForAgent } from "./venueFilters";

const CYCLE_GAP_MS = Math.max(250, Number(process.env.ARB_SCAN_GAP_MS) || 1000);

type WorkerState = { timer: ReturnType<typeof setTimeout> | null; active: boolean };
const workerKey = Symbol.for("sports-trading-bot.arbitrage-scanner");
const globals = globalThis as typeof globalThis & { [workerKey]?: WorkerState };
const worker = globals[workerKey] ?? { timer: null, active: false };
globals[workerKey] = worker;

function pacificDateStr(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${value("year")}${value("month")}${value("day")}`;
}

async function cycle(): Promise<void> {
  if (worker.active) return;
  const health = await getScannerHealth();
  if (!health.enabled) return;
  worker.active = true;
  const date = pacificDateStr();
  const started = Date.now();
  await updateScannerHealth({ running: true, date, cycleStartedAt: new Date(started).toISOString(), lastError: null });

  try {
    const [ingested, agent, risk, venues] = await Promise.all([
      runIngestion(date),
      getAgent(DEFAULT_AGENT.id).then((a) => a ?? DEFAULT_AGENT),
      getRiskSettings(),
      getVenues(),
    ]);
    const activeMarkets = filterMarketsForAgent(ingested.markets, venues, agent);
    const { matched } = matchMarkets(activeMarkets);
    const { opportunities } = detectArbs(matched, agent, {
      minLiquidityUsd: risk.minLiquidityUsd,
      minExpectedProfitUsd: risk.minExpectedProfitUsd,
      liquidityStakeBufferMultiple: risk.liquidityStakeBufferMultiple,
      staleDivergenceCents: risk.staleDivergenceCents,
    });
    await saveOpportunities(date, opportunities);

    let attemptedCount = 0;
    let executedCount = 0;
    let haltedCount = 0;
    let lastResult = null as Awaited<ReturnType<typeof runExecution>>["result"] | null;
    let lastReason: string | null = null;
    if (agent.enabled && agent.autoTrade && !risk.killSwitch) {
      const mode = agent.live && !agent.paper ? "live" : "dry_run";
      // Sequential execution keeps the exposure/position gates authoritative. Concurrent
      // attempts could all read the same pre-fill exposure before any trade is persisted.
      for (const opportunity of opportunities) {
        const outcome = await runExecution(opportunity.id, date, mode);
        attemptedCount += 1;
        lastResult = outcome.result;
        lastReason = outcome.reason;
        if (outcome.result === "executed" || outcome.result === "partial") executedCount += 1;
        else haltedCount += 1;
      }
    }

    await updateScannerHealth({
      running: false,
      date,
      lastCompletedAt: new Date().toISOString(),
      lastSuccessfulTradeAt: executedCount > 0 ? new Date().toISOString() : health.lastSuccessfulTradeAt,
      lastDurationMs: Date.now() - started,
      gameCount: ingested.gameCount,
      marketCount: ingested.markets.length,
      venueCounts: ingested.venueCounts,
      matchedCount: matched.length,
      opportunityCount: opportunities.length,
      attemptedCount,
      executedCount,
      haltedCount,
      lastResult,
      lastReason,
      lastError: null,
      consecutiveFailures: 0,
    });
  } catch (error) {
    const current = await getScannerHealth();
    await updateScannerHealth({
      running: false,
      lastCompletedAt: new Date().toISOString(),
      lastDurationMs: Date.now() - started,
      lastError: String(error).slice(0, 500),
      consecutiveFailures: current.consecutiveFailures + 1,
    });
  } finally {
    worker.active = false;
  }
}

async function schedule(): Promise<void> {
  const health = await getScannerHealth();
  if (!health.enabled) return;
  await cycle();
  if ((await getScannerHealth()).enabled) {
    worker.timer = setTimeout(() => void schedule(), CYCLE_GAP_MS);
  }
}

export async function startArbitrageScanner(): Promise<void> {
  await updateScannerHealth({ enabled: true });
  if (worker.active || worker.timer) return;
  void schedule();
}

export async function resumeArbitrageScanner(): Promise<void> {
  if (!(await getScannerHealth()).enabled || worker.active || worker.timer) return;
  void schedule();
}

export async function stopArbitrageScanner(): Promise<void> {
  await updateScannerHealth({ enabled: false });
  if (worker.timer) clearTimeout(worker.timer);
  worker.timer = null;
}

export async function scannerStatus() {
  return getScannerHealth();
}
