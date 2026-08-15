import fs from "fs/promises";
import path from "path";
import type { Trade } from "@/types/arbitrage";
import { guaranteedTradeEconomics } from "./arbMath";

// Ported from src/lib/liveTradeStore.ts — date-keyed JSON, retains `mode` so paper
// and real trades coexist in the same store.
const DATA_DIR = path.join(process.cwd(), "data", "arbitrage", "trades");
const writeQueues = new Map<string, Promise<unknown>>();

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function tradeFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

async function readDateFile(date: string): Promise<Trade[]> {
  try {
    return JSON.parse(await fs.readFile(tradeFile(date), "utf-8")) as Trade[];
  } catch {
    return [];
  }
}

// Recalculate legacy filled hedges on read so existing portfolio rows use the same
// payout-minus-cost equation as newly executed trades. Do not apply this to naked or
// pending baskets because their minimum leg size is not a guaranteed payout.
function normalizeGuaranteedEconomics(trade: Trade): Trade {
  const isCompletedHedge = trade.fillStatus === "filled"
    && trade.legs.length >= 2
    && trade.legs.every((leg) => leg.size > 0);
  if (!isCompletedHedge) return trade;
  const economics = guaranteedTradeEconomics(trade.legs);
  return {
    ...trade,
    totalCost: economics.totalCost,
    expectedProfit: economics.expectedProfit,
    netEdge: economics.netEdge,
  };
}

async function withDateWriteLock<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(date) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeQueues.set(date, next.finally(() => {
    if (writeQueues.get(date) === next) writeQueues.delete(date);
  }));
  return next;
}

export async function saveTrade(trade: Trade): Promise<void> {
  await withDateWriteLock(trade.date, async () => {
    await ensureDir();
    const existing = await readDateFile(trade.date);
    await fs.writeFile(tradeFile(trade.date), JSON.stringify([...existing, trade], null, 2), "utf-8");
  });
}

export async function updateTrade(id: string, date: string, updates: Partial<Trade>): Promise<boolean> {
  const updated = await withDateWriteLock(date, async () => {
    const trades = await readDateFile(date);
    const idx = trades.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    trades[idx] = { ...trades[idx], ...updates };
    await fs.writeFile(tradeFile(date), JSON.stringify(trades, null, 2), "utf-8");
    return true;
  });
  if (updated && (updates.status === "settled" || updates.status === "closed" || updates.status === "cancelled" || updates.status === "failed")) {
    // The durable reservation, not the JSON file, is the live concurrency authority.
    // Release only after the position has reached a terminal state in persisted storage.
    const { releaseReservationForTrade } = await import("./execution/riskReservation");
    releaseReservationForTrade(id, `trade_${updates.status}`);
  }
  return updated;
}

export async function getTradesByDate(date: string): Promise<Trade[]> {
  return (await readDateFile(date)).map(normalizeGuaranteedEconomics);
}

export async function getAllTrades(): Promise<Trade[]> {
  await ensureDir();
  const files = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
  const dates = files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort().reverse();
  const all = await Promise.all(dates.map((d) => readDateFile(d)));
  return all.flat().map(normalizeGuaranteedEconomics).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
