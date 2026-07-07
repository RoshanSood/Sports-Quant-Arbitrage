import fs from "fs/promises";
import path from "path";
import { ValuePlaysCacheEntry } from "@/types/analysis";

const CACHE_DIR = path.join(process.cwd(), "data", "value-plays-cache");

// In-memory layer for fast reads within the same process
const memStore = new Map<string, ValuePlaysCacheEntry>();
const runningKeys = new Set<string>();

function cacheKey(date: string, source: string): string {
  return `${date}-${source}`;
}

function cacheFile(date: string, source: string): string {
  return path.join(CACHE_DIR, `${date}-${source}.json`);
}

export async function getCached(date: string, source: string): Promise<ValuePlaysCacheEntry | null> {
  const key = cacheKey(date, source);
  if (memStore.has(key)) return memStore.get(key)!;
  try {
    const raw = await fs.readFile(cacheFile(date, source), "utf-8");
    const entry = JSON.parse(raw) as ValuePlaysCacheEntry;
    memStore.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

export async function setCached(date: string, source: string, entry: ValuePlaysCacheEntry): Promise<void> {
  memStore.set(cacheKey(date, source), entry);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheFile(date, source), JSON.stringify(entry, null, 2), "utf-8");
}

export function isRunning(date: string, source: string): boolean {
  return runningKeys.has(cacheKey(date, source));
}

export function setRunning(date: string, source: string, on: boolean): void {
  if (on) runningKeys.add(cacheKey(date, source));
  else runningKeys.delete(cacheKey(date, source));
}
