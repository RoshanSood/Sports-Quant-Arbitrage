// Persistence for the prop scanner (manual §22, §23). No database — date-keyed JSON
// under data/props/, mirroring the arbitrage marketStore pattern: in-memory Map for
// hot reads + a running-set so an ingestion can be fired once and polled by the
// client. Quote history is append-only for auditability; current rows are the
// materialized snapshot the grid reads.

import fs from "fs/promises";
import path from "path";
import type { PropsGridRow, ProviderHealth } from "@/types/props";
import type { PropQuote } from "./normalize";

const ROWS_DIR = path.join(process.cwd(), "data", "props", "rows");
const HISTORY_DIR = path.join(process.cwd(), "data", "props", "history");
const HEALTH_FILE = path.join(process.cwd(), "data", "props", "health.json");

const rowsMem = new Map<string, PropsGridRow[]>();
const runningKeys = new Set<string>();
let healthMem: ProviderHealth[] | null = null;

function rowsFile(date: string) {
  return path.join(ROWS_DIR, `${date}.json`);
}
function historyFile(date: string) {
  return path.join(HISTORY_DIR, `${date}.jsonl`);
}

export async function getRows(date: string): Promise<PropsGridRow[]> {
  if (rowsMem.has(date)) return rowsMem.get(date)!;
  try {
    const raw = await fs.readFile(rowsFile(date), "utf-8");
    const list = JSON.parse(raw) as PropsGridRow[];
    rowsMem.set(date, list);
    return list;
  } catch {
    return [];
  }
}

export async function saveRows(date: string, rows: PropsGridRow[]): Promise<void> {
  rowsMem.set(date, rows);
  await fs.mkdir(ROWS_DIR, { recursive: true });
  await fs.writeFile(rowsFile(date), JSON.stringify(rows, null, 2), "utf-8");
}

// Append-only quote history (one JSON object per line). Best-effort; never blocks
// the grid path (manual §25 — historical writes run async).
export async function appendHistory(date: string, quotes: PropQuote[]): Promise<void> {
  if (!quotes.length) return;
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    const lines = quotes
      .map((q) =>
        JSON.stringify({
          quoteId: q.quoteId,
          canonicalKey: q.canonicalKey,
          bookId: q.bookId,
          side: q.side,
          line: q.line,
          americanOdds: q.americanOdds,
          available: q.available,
          observedAt: q.observedAt,
          sourceUpdatedAt: q.sourceUpdatedAt,
        })
      )
      .join("\n");
    await fs.appendFile(historyFile(date), lines + "\n", "utf-8");
  } catch (e) {
    console.error("[props/store] history append failed:", e);
  }
}

export async function getHealth(): Promise<ProviderHealth[]> {
  if (healthMem) return healthMem;
  try {
    const raw = await fs.readFile(HEALTH_FILE, "utf-8");
    healthMem = JSON.parse(raw) as ProviderHealth[];
    return healthMem;
  } catch {
    return [];
  }
}

export async function saveHealth(health: ProviderHealth[]): Promise<void> {
  healthMem = health;
  await fs.mkdir(path.dirname(HEALTH_FILE), { recursive: true });
  await fs.writeFile(HEALTH_FILE, JSON.stringify(health, null, 2), "utf-8");
}

export function isRunning(date: string): boolean {
  return runningKeys.has(date);
}
export function setRunning(date: string, on: boolean): void {
  if (on) runningKeys.add(date);
  else runningKeys.delete(date);
}
