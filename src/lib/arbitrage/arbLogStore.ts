import fs from "fs/promises";
import path from "path";
import type { ArbLog } from "@/types/arbitrage";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "logs");
const writeQueues = new Map<string, Promise<unknown>>();

function logFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

function appendLogFile(date: string) {
  return path.join(DATA_DIR, `${date}.jsonl`);
}

export function parseJsonLines(text: string): ArbLog[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ArbLog];
      } catch {
        return [];
      }
    });
}

async function readDateFile(date: string): Promise<ArbLog[]> {
  const [legacy, appended] = await Promise.all([
    fs.readFile(logFile(date), "utf-8").then((text) => JSON.parse(text) as ArbLog[]).catch(() => [] as ArbLog[]),
    fs.readFile(appendLogFile(date), "utf-8").then(parseJsonLines).catch(() => [] as ArbLog[]),
  ]);
  return [...appended, ...legacy].sort((a, b) => b.time.localeCompare(a.time));
}

async function withDateWriteLock<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(date) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeQueues.set(date, next.finally(() => {
    if (writeQueues.get(date) === next) writeQueues.delete(date);
  }));
  return next;
}

// New logs are append-only JSONL. The previous JSON-array format rewrote and reparsed the
// entire daily file for every halt (38 MB by the end of 2026-08-11), creating quadratic I/O
// pressure during the exact burst of execution attempts where latency matters most.
// Existing .json history remains readable and is merged with the append-only records.
export async function appendLog(log: ArbLog): Promise<void> {
  await withDateWriteLock(log.date, async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(appendLogFile(log.date), `${JSON.stringify(log)}\n`, "utf-8");
  });
}

export async function getLogs(date?: string): Promise<ArbLog[]> {
  if (date) return readDateFile(date);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const files = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
  const dates = [...new Set(files.flatMap((file) => file.match(/^(\d{8})\.jsonl?$/)?.[1] ?? []))].sort().reverse();
  const all = await Promise.all(dates.map((d) => readDateFile(d)));
  return all.flat().sort((a, b) => b.time.localeCompare(a.time));
}
