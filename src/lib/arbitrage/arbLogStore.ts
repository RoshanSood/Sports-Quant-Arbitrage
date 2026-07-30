import fs from "fs/promises";
import path from "path";
import type { ArbLog } from "@/types/arbitrage";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "logs");
const writeQueues = new Map<string, Promise<unknown>>();
// Dates whose file is already known to be JSONL (migrated or freshly created) in THIS
// process — lets appendLog skip the legacy-detection read after the first append, making
// steady-state appends a true O(1) fs.appendFile with no read.
const jsonlReady = new Set<string>();

function logFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

// New-format files are append-only JSONL (one JSON object per line, oldest-first
// on disk). Legacy files are pretty-printed JSON arrays (newest-first on disk).
// We detect format by the first non-whitespace char: '[' => legacy array.
// Either way this returns NEWEST-FIRST to preserve the original getLogs contract.
export function parseLogFile(raw: string): ArbLog[] {
  const trimmed = raw.trimStart();
  if (!trimmed) return [];
  if (trimmed[0] === "[") {
    // Legacy JSON array, already newest-first on disk.
    return JSON.parse(raw) as ArbLog[];
  }
  // JSONL: one object per non-empty line, oldest-first on disk.
  const out: ArbLog[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    out.push(JSON.parse(s) as ArbLog);
  }
  out.reverse(); // oldest-first on disk -> newest-first for callers
  return out;
}

async function readDateFile(date: string): Promise<ArbLog[]> {
  try {
    return parseLogFile(await fs.readFile(logFile(date), "utf-8"));
  } catch {
    return [];
  }
}

// If the target file is still a legacy JSON array, rewrite it once as JSONL
// (oldest-first on disk) so we never append a line after a `]`-terminated array.
// Must be called inside the write lock.
async function migrateLegacyArrayIfNeeded(file: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return; // no file yet — fresh JSONL will be created by the append
  }
  const trimmed = raw.trimStart();
  if (!trimmed || trimmed[0] !== "[") return; // already JSONL (or empty)
  const arr = JSON.parse(raw) as ArbLog[];
  // Legacy array is newest-first; JSONL on disk is oldest-first, so reverse.
  const lines = arr
    .slice()
    .reverse()
    .map((l) => JSON.stringify(l));
  await fs.writeFile(file, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
}

// Append is fire-and-forget at call sites so logging never blocks execution.
// O(1) append: migrate a legacy array once, then appendFile a single JSONL line.
export async function appendLog(log: ArbLog): Promise<void> {
  await withDateWriteLock(log.date, async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const file = logFile(log.date);
    // Inspect/migrate the file only the FIRST time we append to this date in this process;
    // after that it is known-JSONL, so appends are a pure O(1) fs.appendFile with no read.
    if (!jsonlReady.has(log.date)) {
      await migrateLegacyArrayIfNeeded(file);
      jsonlReady.add(log.date);
    }
    await fs.appendFile(file, JSON.stringify(log) + "\n", "utf-8");
  });
}

async function withDateWriteLock<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(date) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeQueues.set(date, next.finally(() => {
    if (writeQueues.get(date) === next) writeQueues.delete(date);
  }));
  return next;
}

// Safety cap for the no-date (multi-day) path so a caller that omits both date and limit
// can never ship the entire log history (that was ~15MB to the browser and the source of
// the arbitrage page lag).
const MULTIDATE_DEFAULT_LIMIT = 500;

// `limit` caps the number of (newest-first) rows returned. Pass a limit for anything
// user-facing (the log panel); omit it for a single-date lookup that must be exhaustive
// (e.g. the trade postmortem searching a day's logs for one trade).
export async function getLogs(date?: string, limit?: number): Promise<ArbLog[]> {
  if (date) {
    const logs = await readDateFile(date); // newest-first per parseLogFile
    return limit && limit > 0 ? logs.slice(0, limit) : logs;
  }
  // No date: read the most recent date files newest-first and STOP once we have enough —
  // never load every historical file just to show the latest activity.
  await fs.mkdir(DATA_DIR, { recursive: true });
  const files = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
  const dates = files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort().reverse();
  const cap = limit && limit > 0 ? limit : MULTIDATE_DEFAULT_LIMIT;
  const out: ArbLog[] = [];
  for (const d of dates) {
    out.push(...(await readDateFile(d)));
    if (out.length >= cap) break;
  }
  return out.sort((a, b) => b.time.localeCompare(a.time)).slice(0, cap);
}
