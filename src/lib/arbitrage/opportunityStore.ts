import fs from "fs/promises";
import path from "path";
import type { ArbOpportunity } from "@/types/arbitrage";

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
    const raw = await fs.readFile(oppFile(date), "utf-8");
    const list = JSON.parse(raw) as ArbOpportunity[];
    memStore.set(date, list);
    return list;
  } catch {
    return [];
  }
}

export async function saveOpportunities(date: string, list: ArbOpportunity[]): Promise<void> {
  memStore.set(date, list);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(oppFile(date), JSON.stringify(list, null, 2), "utf-8");
}

export function isRunning(date: string): boolean {
  return runningKeys.has(date);
}

export function setRunning(date: string, on: boolean): void {
  if (on) runningKeys.add(date);
  else runningKeys.delete(date);
}
