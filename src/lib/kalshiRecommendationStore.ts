import fs from "fs/promises";
import path from "path";
import { TrackedRecommendation } from "@/types/performance";
import { addKalshiBankrollBet } from "@/lib/kalshiBankrollStore";

const DATA_DIR = path.join(process.cwd(), "data", "kalshi-recommendations");
const INDEX_FILE = path.join(DATA_DIR, ".index");

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

export async function saveKalshiRecommendations(
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
    const existingIds = new Set(existing.map((r) => r.id));
    const toAdd = newRecs.filter((r) => !existingIds.has(r.id));
    if (toAdd.length) {
      await writeDateFile(date, [...existing, ...toAdd]);
      await addToIndex(date);
      for (const rec of toAdd) {
        await addKalshiBankrollBet(rec).catch((e) => console.error("[kalshi-bankroll]", e));
      }
    }
  }
}

export async function getAllKalshiRecommendations(): Promise<TrackedRecommendation[]> {
  const dates = await readIndex();
  const all = await Promise.all(dates.map(readDateFile));
  return all.flat().sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function getPendingKalshiRecommendations(): Promise<TrackedRecommendation[]> {
  const all = await getAllKalshiRecommendations();
  return all.filter((r) => r.status === "pending");
}

export async function updateKalshiRecommendation(
  id: string,
  updates: Partial<TrackedRecommendation>
): Promise<boolean> {
  const date = id.split("-")[0];
  if (!date || date.length !== 8) {
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
