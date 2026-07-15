import path from "path";
import type { ArbOpportunity } from "@/types/arbitrage";
import { readJson, writeJsonAtomic } from "./jsonStore";

// Date-keyed opportunity cache. Mirrors src/lib/valuePlaysCache.ts: in-memory Map
// for hot reads + a running-set so a scan can be fired once and polled.
const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "opportunities");

const memStore = new Map<string, ArbOpportunity[]>();
const runningKeys = new Set<string>();

function oppFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

export async function getOpportunities(date: string): Promise<ArbOpportunity[]> {
  if (memStore.has(date)) return memStore.get(date)!;
  try {
    const list = await readJson(oppFile(date), [] as ArbOpportunity[]);
    memStore.set(date, list);
    return list;
  } catch {
    return [];
  }
}

export async function saveOpportunities(date: string, list: ArbOpportunity[]): Promise<void> {
  await writeJsonAtomic(oppFile(date), list);
  memStore.set(date, list);
}

export function isRunning(date: string): boolean {
  return runningKeys.has(date);
}

export function setRunning(date: string, on: boolean): void {
  if (on) runningKeys.add(date);
  else runningKeys.delete(date);
}
