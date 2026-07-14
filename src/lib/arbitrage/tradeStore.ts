import fs from "fs/promises";
import path from "path";
import type { Trade } from "@/types/arbitrage";

// Ported from src/lib/liveTradeStore.ts — date-keyed JSON, retains `mode` so paper
// and real trades coexist in the same store.
const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "trades");

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function tradeFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

async function readDateFile(date: string): Promise<Trade[]> {
  try {
    return JSON.parse(await fs.readFile(tradeFile(date), "utf-8"));
  } catch {
    return [];
  }
}

export async function saveTrade(trade: Trade): Promise<void> {
  await ensureDir();
  const existing = await readDateFile(trade.date);
  await fs.writeFile(tradeFile(trade.date), JSON.stringify([...existing, trade], null, 2), "utf-8");
}

export async function updateTrade(id: string, date: string, updates: Partial<Trade>): Promise<boolean> {
  const trades = await readDateFile(date);
  const idx = trades.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  trades[idx] = { ...trades[idx], ...updates };
  await fs.writeFile(tradeFile(date), JSON.stringify(trades, null, 2), "utf-8");
  return true;
}

export async function getTradesByDate(date: string): Promise<Trade[]> {
  return readDateFile(date);
}

export async function getAllTrades(): Promise<Trade[]> {
  await ensureDir();
  const files = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
  const dates = files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort().reverse();
  const all = await Promise.all(dates.map((d) => readDateFile(d)));
  return all.flat().sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
