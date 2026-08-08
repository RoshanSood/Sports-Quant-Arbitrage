import fs from "fs/promises";
import path from "path";
import type { ArbResult, VenueId } from "@/types/arbitrage";

export type ScannerHealth = {
  enabled: boolean;
  running: boolean;
  date: string | null;
  cycleStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulTradeAt: string | null;
  lastDurationMs: number | null;
  gameCount: number;
  marketCount: number;
  venueCounts: Record<VenueId, number>;
  matchedCount: number;
  opportunityCount: number;
  attemptedCount: number;
  executedCount: number;
  haltedCount: number;
  lastResult: ArbResult | null;
  lastReason: string | null;
  lastError: string | null;
  consecutiveFailures: number;
};

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "scanner.json");

const DEFAULT_HEALTH: ScannerHealth = {
  enabled: true,
  running: false,
  date: null,
  cycleStartedAt: null,
  lastCompletedAt: null,
  lastSuccessfulTradeAt: null,
  lastDurationMs: null,
  gameCount: 0,
  marketCount: 0,
  venueCounts: {},
  matchedCount: 0,
  opportunityCount: 0,
  attemptedCount: 0,
  executedCount: 0,
  haltedCount: 0,
  lastResult: null,
  lastReason: null,
  lastError: null,
  consecutiveFailures: 0,
};

let memory: ScannerHealth | null = null;

export async function getScannerHealth(): Promise<ScannerHealth> {
  if (memory) return memory;
  try {
    const stored = JSON.parse(await fs.readFile(FILE, "utf-8")) as Partial<ScannerHealth>;
    memory = { ...DEFAULT_HEALTH, ...stored, running: false };
  } catch {
    memory = { ...DEFAULT_HEALTH };
  }
  return memory;
}

export async function updateScannerHealth(partial: Partial<ScannerHealth>): Promise<ScannerHealth> {
  const next = { ...(await getScannerHealth()), ...partial };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(next, null, 2), "utf-8");
  await fs.rename(temporary, FILE);
  memory = next;
  return next;
}
