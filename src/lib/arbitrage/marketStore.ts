import fs from "fs/promises";
import path from "path";
import type { NormalizedMarket } from "@/types/arbitrage";
import { readJson, writeJsonAtomic } from "./jsonStore";

// Date-keyed normalized-market cache (Phase 3 ingestion output). Mirrors the
// valuePlaysCache pattern: in-memory Map for hot reads + a running-set so an
// ingestion can be fired once and polled by the client.
const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "markets");

const memStore = new Map<string, NormalizedMarket[]>();
const runningKeys = new Set<string>();

function marketFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

export async function getMarkets(date: string): Promise<NormalizedMarket[]> {
  if (memStore.has(date)) return memStore.get(date)!;
  try {
    const list = await readJson(marketFile(date), [] as NormalizedMarket[]);
    memStore.set(date, list);
    return list;
  } catch {
    return [];
  }
}

export async function saveMarkets(date: string, list: NormalizedMarket[]): Promise<void> {
  await writeJsonAtomic(marketFile(date), list);
  memStore.set(date, list);
}

export async function marketCacheAgeMs(date: string): Promise<number> {
  const stat = await fs.stat(marketFile(date)).catch(() => null);
  return stat ? Math.max(0, Date.now() - stat.mtimeMs) : Number.POSITIVE_INFINITY;
}

export function ingestionLockFile(date: string): string {
  return path.join(DATA_DIR, `${date}.ingestion`);
}

export function isRunning(date: string): boolean {
  return runningKeys.has(date);
}

export function setRunning(date: string, on: boolean): void {
  if (on) runningKeys.add(date);
  else runningKeys.delete(date);
}
