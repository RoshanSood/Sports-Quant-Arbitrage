import fs from "fs/promises";
import path from "path";
import type { NormalizedMarket } from "@/types/arbitrage";

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
    const raw = await fs.readFile(marketFile(date), "utf-8");
    const list = JSON.parse(raw) as NormalizedMarket[];
    memStore.set(date, list);
    return list;
  } catch {
    return [];
  }
}

export async function saveMarkets(date: string, list: NormalizedMarket[]): Promise<void> {
  memStore.set(date, list);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(marketFile(date), JSON.stringify(list, null, 2), "utf-8");
}

export function isRunning(date: string): boolean {
  return runningKeys.has(date);
}

export function setRunning(date: string, on: boolean): void {
  if (on) runningKeys.add(date);
  else runningKeys.delete(date);
}
