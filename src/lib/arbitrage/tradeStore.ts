import fs from "fs/promises";
import path from "path";
import type { Trade } from "@/types/arbitrage";
import { mutateJson, readJson } from "./jsonStore";

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
  return readJson(tradeFile(date), [] as Trade[]);
}

export async function saveTrade(trade: Trade): Promise<void> {
  await ensureDir();
  await mutateJson(tradeFile(trade.date), [] as Trade[], (existing) => ({
    value: [...existing, trade],
    result: undefined,
  }));
}

export async function updateTrade(id: string, date: string, updates: Partial<Trade>): Promise<boolean> {
  return mutateJson(tradeFile(date), [] as Trade[], (trades) => {
    const idx = trades.findIndex((trade) => trade.id === id);
    if (idx === -1) return { value: trades, result: false };
    const next = [...trades];
    next[idx] = { ...next[idx], ...updates };
    return { value: next, result: true };
  });
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
