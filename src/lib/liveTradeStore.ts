import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "live-trades");

export type LiveTradeStatus =
  | "open"
  | "filled"
  | "partially_filled"
  | "cancelled"
  | "error";

export type LiveTrade = {
  id: string;
  orderId: string | null;
  recId: string;
  date: string;              // YYYYMMDD
  ticker: string;
  side: "yes" | "no";
  contracts: number;
  limitPriceCents: number;
  estimatedCost: number;
  game: string;              // "BOS @ NYY"
  pick: string;              // "BOS ML", "BOS -1.5", "O 8.5"
  marketType: string;
  placedAt: string;          // ISO timestamp
  status: LiveTradeStatus;
  fillPrice?: number | null;
  filledContracts?: number | null;
  actualCost?: number | null;
  errorMessage?: string | null;
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function tradeFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

async function readDateFile(date: string): Promise<LiveTrade[]> {
  try {
    return JSON.parse(await fs.readFile(tradeFile(date), "utf-8"));
  } catch {
    return [];
  }
}

export async function saveLiveTrade(trade: LiveTrade): Promise<void> {
  await ensureDir();
  const existing = await readDateFile(trade.date);
  await fs.writeFile(
    tradeFile(trade.date),
    JSON.stringify([...existing, trade], null, 2),
    "utf-8"
  );
}

export async function updateLiveTrade(
  id: string,
  date: string,
  updates: Partial<LiveTrade>
): Promise<boolean> {
  const trades = await readDateFile(date);
  const idx = trades.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  trades[idx] = { ...trades[idx], ...updates };
  await fs.writeFile(tradeFile(date), JSON.stringify(trades, null, 2), "utf-8");
  return true;
}

export async function getLiveTrades(date?: string): Promise<LiveTrade[]> {
  if (date) return readDateFile(date);
  await ensureDir();
  const files = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
  const dates = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .sort()
    .reverse();
  const all = await Promise.all(dates.map((d) => readDateFile(d)));
  return all.flat().sort((a, b) => b.placedAt.localeCompare(a.placedAt));
}

export async function getTodayTrades(date: string): Promise<LiveTrade[]> {
  return readDateFile(date);
}
