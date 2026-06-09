import fs from "fs/promises";
import path from "path";
import {
  BankrollBet,
  BankrollData,
  DayBankrollSummary,
  RecommendationStatus,
  TrackedRecommendation,
} from "@/types/performance";

const DATA_FILE = path.join(process.cwd(), "data", "bankroll.json");
const STARTING_BALANCE = 100;
const DEFAULT_UNIT_SIZE = 10;
// Bets are only tracked from this date onward
export const FIRST_TRACKING_DATE = "20260523";

type StoredData = { unitSize: number; bets: BankrollBet[] };

export function unitsForConfidence(confidence: number): number {
  if (confidence >= 9) return 2;
  if (confidence >= 7) return 1.5;
  if (confidence >= 5) return 1;
  return 0.5;
}

function betProfit(bet: BankrollBet): number | null {
  if (bet.status === "pending" || bet.status === "void") return null;
  if (bet.status === "push") return 0;
  if (bet.status === "loss") return -bet.betAmount;
  if (bet.status === "win") {
    const p = bet.price;
    if (p == null || p <= 0 || p >= 1) return bet.betAmount; // fallback: 1:1
    return parseFloat((bet.betAmount * (1 - p) / p).toFixed(2));
  }
  return null;
}

async function read(): Promise<StoredData> {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf-8"));
  } catch {
    return { unitSize: DEFAULT_UNIT_SIZE, bets: [] };
  }
}

async function write(data: StoredData): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export async function addBankrollBet(rec: TrackedRecommendation): Promise<void> {
  const data = await read();
  if (data.bets.some((b) => b.recId === rec.id)) return;

  const units = unitsForConfidence(rec.confidence);
  const betAmount = parseFloat((units * data.unitSize).toFixed(2));

  data.bets.push({
    recId: rec.id,
    date: rec.date,
    game: `${rec.awayTeam.abbreviation} @ ${rec.homeTeam.abbreviation}`,
    pick: rec.recommendedPick,
    marketType: rec.marketType,
    confidence: rec.confidence,
    units,
    betAmount,
    price: rec.price,
    displayPrice: rec.displayPrice,
    status: "pending",
    profit: null,
    placedAt: rec.generatedAt,
    settledAt: null,
  });

  await write(data);
}

export async function updateBankrollBetStatus(
  recId: string,
  status: RecommendationStatus
): Promise<void> {
  const data = await read();
  const bet = data.bets.find((b) => b.recId === recId);
  if (!bet) return;

  bet.status = status;
  bet.settledAt = new Date().toISOString();
  bet.profit = betProfit(bet);

  await write(data);
}

export async function setUnitSize(unitSize: number): Promise<void> {
  const data = await read();
  data.unitSize = unitSize;
  await write(data);
}

export async function getBankrollData(date?: string): Promise<BankrollData> {
  const data = await read();
  const { unitSize, bets } = data;

  const sorted = [...bets].sort((a, b) => a.placedAt.localeCompare(b.placedAt));

  // Overall current balance
  let balance = STARTING_BALANCE;
  for (const bet of sorted) {
    if (bet.profit !== null) balance += bet.profit;
  }
  const totalProfit = parseFloat((balance - STARTING_BALANCE).toFixed(2));

  // Unique dates on or after the first tracking date, sorted ascending
  const availableDates = [...new Set(bets.map((b) => b.date))]
    .filter((d) => d >= FIRST_TRACKING_DATE)
    .sort();

  // Which date to build day summary for
  const targetDate = date ?? availableDates[availableDates.length - 1] ?? FIRST_TRACKING_DATE;

  // Starting balance for this day: $100 + settled profits from bets placed BEFORE this date
  let dayStart = STARTING_BALANCE;
  for (const bet of sorted) {
    if (bet.date < targetDate && bet.profit !== null) {
      dayStart += bet.profit;
    }
  }

  const dayBets = bets.filter((b) => b.date === targetDate);
  const settledDayBets = dayBets.filter((b) => b.profit !== null);
  const dayProfit = parseFloat(
    settledDayBets.reduce((s, b) => s + (b.profit ?? 0), 0).toFixed(2)
  );

  const dayData: DayBankrollSummary = {
    date: targetDate,
    startingBalance: parseFloat(dayStart.toFixed(2)),
    dayProfit,
    bets: dayBets,
    pendingCount: dayBets.filter((b) => b.status === "pending").length,
    settledCount: settledDayBets.length,
    totalBetAmount: parseFloat(dayBets.reduce((s, b) => s + b.betAmount, 0).toFixed(2)),
  };

  return {
    startingBalance: STARTING_BALANCE,
    unitSize,
    currentBalance: parseFloat(balance.toFixed(2)),
    totalProfit,
    totalProfitPct: parseFloat((totalProfit / STARTING_BALANCE * 100).toFixed(2)),
    availableDates,
    bets,
    dayData,
  };
}
