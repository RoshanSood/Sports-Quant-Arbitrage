import fs from "fs/promises";
import path from "path";
import type { NormalizedMarket } from "@/types/arbitrage";
import type { VenueFetchTiming } from "./ingest";
import { dateParamToStorageDate } from "./date";

// Date-keyed normalized-market cache (Phase 3 ingestion output). Mirrors the
// valuePlaysCache pattern: in-memory Map for hot reads + a running-set so an
// ingestion can be fired once and polled by the client.
const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "markets");

const memStore = new Map<string, NormalizedMarket[]>();
const runningKeys = new Set<string>();
// Debounced disk persistence: memStore is the immediate source of truth; the
// on-disk file is only the cold-start path (process restart). Coalesce writes to
// at most once per DEBOUNCE_MS per date, always flushing the latest state.
const DEBOUNCE_MS = 1000;
const pendingWrites = new Map<string, NormalizedMarket[]>();
const flushTimers = new Map<string, NodeJS.Timeout>();
// Per-venue fetch timings from the most recent ingest of each date (in-memory only —
// diagnostics telemetry, not trade state), so the diagnostics endpoint can show which
// venue was slow/failed even though it reads from the persisted market snapshot.
const ingestTimings = new Map<string, VenueFetchTiming[]>();

function storageKey(date: string) {
  return dateParamToStorageDate(date);
}

function marketFile(date: string) {
  return path.join(DATA_DIR, `${storageKey(date)}.json`);
}

export async function getMarkets(date: string): Promise<NormalizedMarket[]> {
  const key = storageKey(date);
  if (memStore.has(key)) return memStore.get(key)!;
  try {
    const raw = await fs.readFile(marketFile(date), "utf-8");
    const list = JSON.parse(raw) as NormalizedMarket[];
    memStore.set(key, list);
    return list;
  } catch {
    return [];
  }
}

export async function saveMarkets(date: string, list: NormalizedMarket[]): Promise<void> {
  const key = storageKey(date);
  memStore.set(key, list); // immediate source of truth (getMarkets prefers memStore)
  pendingWrites.set(key, list); // latest state to persist
  scheduleFlush(key); // coalesced disk write; resolves immediately (no per-scan disk wait)
}

function scheduleFlush(key: string): void {
  if (flushTimers.has(key)) return; // a flush is already pending; it will pick up the latest
  const timer = setTimeout(() => {
    flushTimers.delete(key);
    void flushKey(key);
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive just for a pending market flush.
  if (typeof timer.unref === "function") timer.unref();
  flushTimers.set(key, timer);
}

async function flushKey(key: string): Promise<void> {
  const list = pendingWrites.get(key);
  if (!list) return;
  pendingWrites.delete(key);
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(marketFile(key), JSON.stringify(list, null, 2), "utf-8");
  } catch (e) {
    console.error("[arbitrage/marketStore] debounced flush failed:", e);
  }
}

// Force any pending debounced writes to disk immediately (graceful shutdown / tests).
export async function flushMarkets(date?: string): Promise<void> {
  const keys = date ? [storageKey(date)] : [...pendingWrites.keys()];
  for (const key of keys) {
    const timer = flushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      flushTimers.delete(key);
    }
    await flushKey(key);
  }
}

export function setIngestTimings(date: string, timings: VenueFetchTiming[]): void {
  ingestTimings.set(storageKey(date), timings);
}

export function getIngestTimings(date: string): VenueFetchTiming[] {
  return ingestTimings.get(storageKey(date)) ?? [];
}

export function isRunning(date: string): boolean {
  return runningKeys.has(storageKey(date));
}

export function setRunning(date: string, on: boolean): void {
  const key = storageKey(date);
  if (on) runningKeys.add(key);
  else runningKeys.delete(key);
}
