import fs from "fs/promises";
import path from "path";
import type { ArbLog } from "@/types/arbitrage";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "logs");
const writeQueues = new Map<string, Promise<unknown>>();

function logFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

async function readDateFile(date: string): Promise<ArbLog[]> {
  try {
    return JSON.parse(await fs.readFile(logFile(date), "utf-8"));
  } catch {
    return [];
  }
}

async function withDateWriteLock<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(date) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeQueues.set(date, next.finally(() => {
    if (writeQueues.get(date) === next) writeQueues.delete(date);
  }));
  return next;
}

// Append is fire-and-forget at call sites so logging never blocks execution.
export async function appendLog(log: ArbLog): Promise<void> {
  await withDateWriteLock(log.date, async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const existing = await readDateFile(log.date);
    await fs.writeFile(logFile(log.date), JSON.stringify([log, ...existing], null, 2), "utf-8");
  });
}

export async function getLogs(date?: string): Promise<ArbLog[]> {
  if (date) return readDateFile(date);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const files = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
  const dates = files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort().reverse();
  const all = await Promise.all(dates.map((d) => readDateFile(d)));
  return all.flat().sort((a, b) => b.time.localeCompare(a.time));
}
