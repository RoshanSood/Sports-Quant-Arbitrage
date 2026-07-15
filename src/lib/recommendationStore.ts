import fs from "fs/promises";
import path from "path";
import {
  TrackedRecommendation,
  RecordStats,
  PerformanceBreakdown,
  League,
  MarketType,
  ClaudeRating,
} from "@/types/performance";
import { addBankrollBet } from "@/lib/bankrollStore";

const DATA_DIR = path.join(process.cwd(), "data", "recommendations");
const INDEX_FILE = path.join(DATA_DIR, ".index");

// ── File helpers ──────────────────────────────────────────────────────────────

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function recFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

async function readDateFile(date: string): Promise<TrackedRecommendation[]> {
  try {
    return JSON.parse(await fs.readFile(recFile(date), "utf-8"));
  } catch {
    return [];
  }
}

async function writeDateFile(date: string, recs: TrackedRecommendation[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(recFile(date), JSON.stringify(recs, null, 2), "utf-8");
}

// Maintains a list of dates that have data (avoids scanning the whole directory)
async function readIndex(): Promise<string[]> {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf-8");
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function addToIndex(date: string): Promise<void> {
  await ensureDir();
  const dates = await readIndex();
  if (!dates.includes(date)) {
    await fs.appendFile(INDEX_FILE, `${date}\n`, "utf-8");
  }
}

// Unique ID: date + gameId prefix + market + side + random
export function generateRecId(
  date: string,
  gameId: string,
  market: string,
  side: string
): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-${gameId.slice(-6)}-${market[0]}-${side[0]}-${rand}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function saveRecommendations(
  recs: TrackedRecommendation[]
): Promise<void> {
  if (!recs.length) return;

  const byDate = new Map<string, TrackedRecommendation[]>();
  for (const r of recs) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }

  for (const [date, newRecs] of byDate) {
    const existing = await readDateFile(date);
    // Dedup by id — don't store the same recommendation twice
    const existingIds = new Set(existing.map((r) => r.id));
    const toAdd = newRecs.filter((r) => !existingIds.has(r.id));
    if (toAdd.length) {
      await writeDateFile(date, [...existing, ...toAdd]);
      await addToIndex(date);
      // Register each new recommendation as a mock bankroll bet
      for (const rec of toAdd) {
        await addBankrollBet(rec).catch((e) => console.error("[bankroll]", e));
      }
    }
  }
}

export async function getAllRecommendations(): Promise<TrackedRecommendation[]> {
  const dates = await readIndex();
  const all = await Promise.all(dates.map(readDateFile));
  return all.flat().sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function getPendingRecommendations(): Promise<TrackedRecommendation[]> {
  const all = await getAllRecommendations();
  return all.filter((r) => r.status === "pending");
}

export async function updateRecommendation(
  id: string,
  updates: Partial<TrackedRecommendation>
): Promise<boolean> {
  const date = id.split("-")[0]; // ID starts with YYYYMMDD
  if (!date || date.length !== 8) {
    // Fallback: scan all dates
    const dates = await readIndex();
    for (const d of dates) {
      if (await updateInDate(d, id, updates)) return true;
    }
    return false;
  }
  return updateInDate(date, id, updates);
}

async function updateInDate(
  date: string,
  id: string,
  updates: Partial<TrackedRecommendation>
): Promise<boolean> {
  const recs = await readDateFile(date);
  const idx = recs.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  recs[idx] = { ...recs[idx], ...updates };
  await writeDateFile(date, recs);
  return true;
}

// ── Stats computation ─────────────────────────────────────────────────────────

function computeStats(recs: TrackedRecommendation[]): RecordStats {
  let wins = 0, losses = 0, pushes = 0, pending = 0, unitsPL = 0;

  for (const r of recs) {
    if (r.status === "pending") { pending++; continue; }
    if (r.status === "void") continue;

    const p = r.price ?? 0.5;
    if (r.status === "win") {
      wins++;
      unitsPL += p > 0 ? (1 - p) / p : 0;
    } else if (r.status === "loss") {
      losses++;
      unitsPL -= 1;
    } else if (r.status === "push") {
      pushes++;
      // pushes don't change units P&L
    }
  }

  const gradedBets = wins + losses;
  const winRate = gradedBets > 0 ? wins / gradedBets : 0;
  const roi = gradedBets > 0 ? (unitsPL / gradedBets) * 100 : 0;

  return { wins, losses, pushes, pending, winRate, unitsPL, roi };
}

function avgConf(recs: TrackedRecommendation[], status: "win" | "loss"): number | null {
  const filtered = recs.filter((r) => r.status === status);
  if (!filtered.length) return null;
  return filtered.reduce((s, r) => s + r.confidence, 0) / filtered.length;
}

export function computeBreakdown(recs: TrackedRecommendation[]): PerformanceBreakdown {
  const leagues: League[] = ["MLB", "WNBA"];
  const markets: MarketType[] = ["moneyline", "spread", "total"];
  const ratings: ClaudeRating[] = ["safe", "lean", "risky", "avoid"];

  return {
    overall: computeStats(recs),

    byLeague: Object.fromEntries(
      leagues.map((l) => [l, computeStats(recs.filter((r) => r.league === l))])
    ) as Record<League, RecordStats>,

    byMarket: Object.fromEntries(
      markets.map((m) => [m, computeStats(recs.filter((r) => r.marketType === m))])
    ) as Record<MarketType, RecordStats>,

    byConfidence: {
      high:   computeStats(recs.filter((r) => r.confidence >= 8)),
      medium: computeStats(recs.filter((r) => r.confidence >= 6 && r.confidence < 8)),
      low:    computeStats(recs.filter((r) => r.confidence < 6)),
    },

    byRating: Object.fromEntries(
      ratings.map((rt) => [rt, computeStats(recs.filter((r) => r.rating === rt))])
    ) as Record<ClaudeRating, RecordStats>,

    avgConfidenceWins:   avgConf(recs, "win"),
    avgConfidenceLosses: avgConf(recs, "loss"),
  };
}
