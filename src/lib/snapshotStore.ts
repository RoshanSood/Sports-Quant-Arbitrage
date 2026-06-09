import fs from "fs/promises";
import path from "path";
import { MarketSnapshot, PriceHistory, GameMovement, MarketType, League } from "@/types/snapshots";
import { MLBGame } from "@/types";
import { WNBAGame } from "@/types/wnba";

const DATA_DIR = path.join(process.cwd(), "data", "snapshots");

// ── File helpers ─────────────────────────────────────────────────────────────

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function snapshotFile(date: string) {
  return path.join(DATA_DIR, `${date}.json`);
}

async function readFile(date: string): Promise<MarketSnapshot[]> {
  try {
    const raw = await fs.readFile(snapshotFile(date), "utf-8");
    return JSON.parse(raw) as MarketSnapshot[];
  } catch {
    return [];
  }
}

async function writeFile(date: string, data: MarketSnapshot[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(snapshotFile(date), JSON.stringify(data), "utf-8");
}

// ── Dedup key ─────────────────────────────────────────────────────────────────

function dedupKey(s: MarketSnapshot) {
  return `${s.gameId}||${s.marketType}||${s.outcomeSide}`;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Save ──────────────────────────────────────────────────────────────────────

// Save new snapshots with deduplication:
// Only persist a snapshot if price changed ≥1¢ from the last, OR >30min have passed.
export async function saveSnapshots(incoming: MarketSnapshot[]): Promise<void> {
  if (!incoming.length) return;

  // Group by date (should almost always be one date, but handle edge cases)
  const byDate = new Map<string, MarketSnapshot[]>();
  for (const s of incoming) {
    const bucket = byDate.get(s.date) ?? [];
    bucket.push(s);
    byDate.set(s.date, bucket);
  }

  for (const [date, batch] of byDate) {
    const existing = await readFile(date);

    // Build fast lookup: key → last snapshot
    const lastByKey = new Map<string, MarketSnapshot>();
    for (const s of existing) {
      const k = dedupKey(s);
      const prev = lastByKey.get(k);
      if (!prev || s.capturedAt > prev.capturedAt) lastByKey.set(k, s);
    }

    const toAdd: MarketSnapshot[] = [];
    for (const snap of batch) {
      const k = dedupKey(snap);
      const last = lastByKey.get(k);

      if (!last) {
        toAdd.push(snap);
        lastByKey.set(k, snap);
        continue;
      }

      const priceDelta = Math.abs((snap.price ?? 0) - (last.price ?? 0));
      const ageSec = (new Date(snap.capturedAt).getTime() - new Date(last.capturedAt).getTime()) / 1000;

      if (priceDelta >= 0.01 || ageSec >= 1800 /* 30 min */) {
        toAdd.push(snap);
        lastByKey.set(k, snap);
      }
    }

    if (toAdd.length) {
      await writeFile(date, [...existing, ...toAdd]);
    }
  }
}

// ── Query ─────────────────────────────────────────────────────────────────────

export async function getSnapshotsForDate(
  date: string,
  league?: League
): Promise<MarketSnapshot[]> {
  const all = await readFile(date);
  return league ? all.filter((s) => s.league === league) : all;
}

// ── Build movement data ───────────────────────────────────────────────────────

export function buildMovements(snapshots: MarketSnapshot[]): GameMovement[] {
  // Group by dedupKey → sorted history
  const groups = new Map<string, MarketSnapshot[]>();
  for (const s of snapshots) {
    const k = dedupKey(s);
    const arr = groups.get(k) ?? [];
    arr.push(s);
    groups.set(k, arr);
  }

  // Sort each group chronologically
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  // Convert each group to PriceHistory
  const histories: PriceHistory[] = [];
  for (const [key, sorted] of groups) {
    const open = sorted[0];
    const current = sorted[sorted.length - 1];
    const previous = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
    histories.push({
      key,
      gameId: open.gameId,
      league: open.league,
      marketType: open.marketType,
      outcomeSide: open.outcomeSide,
      matchup: open.matchup,
      outcomeLabel: open.outcomeLabel,
      teamAbbreviation: open.teamAbbreviation,
      line: open.line,
      history: sorted,
      open,
      current,
      previous,
      changeFromOpen: (current.price ?? 0) - (open.price ?? 0),
      recentChange: previous ? (current.price ?? 0) - (previous.price ?? 0) : 0,
    });
  }

  // Group by gameId
  const byGame = new Map<string, PriceHistory[]>();
  for (const h of histories) {
    const arr = byGame.get(h.gameId) ?? [];
    arr.push(h);
    byGame.set(h.gameId, arr);
  }

  // Build GameMovement array
  const movements: GameMovement[] = [];
  for (const [gameId, hs] of byGame) {
    const sample = hs[0];
    const markets: Record<MarketType, PriceHistory[]> = {
      moneyline: hs.filter((h) => h.marketType === "moneyline"),
      spread: hs.filter((h) => h.marketType === "spread"),
      total: hs.filter((h) => h.marketType === "total"),
    };
    movements.push({
      gameId,
      league: sample.league,
      matchup: sample.matchup,
      startTime: "", // filled by the query endpoint
      date: sample.open.date,
      markets,
    });
  }

  // Sort by gameId (stable order)
  movements.sort((a, b) => a.gameId.localeCompare(b.gameId));
  return movements;
}

// ── Snapshot factory helpers ──────────────────────────────────────────────────

function centStr(price: number | null): string {
  if (price == null) return "N/A";
  return `${Math.round(price * 100)}¢`;
}

export function snapshotsFromMLBGame(game: MLBGame, date: string): MarketSnapshot[] {
  if (!game.market) return [];
  const now = new Date().toISOString();
  const matchup = `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`;
  const out: MarketSnapshot[] = [];

  // Helper to push two sides
  function push(
    marketType: "moneyline" | "spread" | "total",
    awayLabel: string,
    awayPrice: number | null,
    awayLine: string | null | undefined,
    homeLabel: string,
    homePrice: number | null,
    homeLine: string | null | undefined,
    overLabel?: string,
    overPrice?: number | null,
    underLabel?: string,
    underPrice?: number | null,
    lineVal?: string | null
  ) {
    if (marketType === "total") {
      if (overLabel !== undefined) {
        out.push({
          id: uid(), league: "MLB", gameId: game.id, date, marketType, matchup,
          outcomeLabel: overLabel, outcomeSide: "over",
          price: overPrice ?? null, displayPrice: centStr(overPrice ?? null),
          line: lineVal, capturedAt: now,
        });
      }
      if (underLabel !== undefined) {
        out.push({
          id: uid(), league: "MLB", gameId: game.id, date, marketType, matchup,
          outcomeLabel: underLabel, outcomeSide: "under",
          price: underPrice ?? null, displayPrice: centStr(underPrice ?? null),
          line: lineVal, capturedAt: now,
        });
      }
    } else {
      out.push({
        id: uid(), league: "MLB", gameId: game.id, date, marketType, matchup,
        outcomeLabel: awayLabel, outcomeSide: "away",
        teamAbbreviation: game.awayTeam.abbreviation,
        price: awayPrice, displayPrice: centStr(awayPrice),
        line: awayLine ?? null, capturedAt: now,
      });
      out.push({
        id: uid(), league: "MLB", gameId: game.id, date, marketType, matchup,
        outcomeLabel: homeLabel, outcomeSide: "home",
        teamAbbreviation: game.homeTeam.abbreviation,
        price: homePrice, displayPrice: centStr(homePrice),
        line: homeLine ?? null, capturedAt: now,
      });
    }
  }

  const ml = game.market.moneyline ?? [];
  if (ml.length >= 2) {
    push("moneyline", ml[0].label, ml[0].price, null, ml[1].label, ml[1].price, null);
  }

  const sp = game.market.spread ?? [];
  if (sp.length >= 2) {
    const awayLine = sp[0].label.includes(" ") ? sp[0].label.split(" ").slice(1).join(" ") : null;
    const homeLine = sp[1].label.includes(" ") ? sp[1].label.split(" ").slice(1).join(" ") : null;
    push("spread", sp[0].label, sp[0].price, awayLine, sp[1].label, sp[1].price, homeLine);
  }

  const tot = game.market.total ?? [];
  if (tot.length >= 2) {
    const lineVal = tot[0].label.includes(" ") ? tot[0].label.split(" ")[1] : null;
    push("total", "", null, null, "", null, null, tot[0].label, tot[0].price, tot[1].label, tot[1].price, lineVal);
  }

  return out;
}

export function snapshotsFromWNBAGame(game: WNBAGame, date: string): MarketSnapshot[] {
  if (!game.market) return [];
  const now = new Date().toISOString();
  const matchup = `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`;
  const out: MarketSnapshot[] = [];

  const ml = game.market.moneyline ?? [];
  if (ml.length >= 2) {
    out.push({
      id: uid(), league: "WNBA", gameId: game.id, date, marketType: "moneyline", matchup,
      outcomeLabel: ml[0].label, outcomeSide: "away",
      teamAbbreviation: game.awayTeam.abbreviation,
      price: ml[0].price, displayPrice: centStr(ml[0].price),
      capturedAt: now,
    });
    out.push({
      id: uid(), league: "WNBA", gameId: game.id, date, marketType: "moneyline", matchup,
      outcomeLabel: ml[1].label, outcomeSide: "home",
      teamAbbreviation: game.homeTeam.abbreviation,
      price: ml[1].price, displayPrice: centStr(ml[1].price),
      capturedAt: now,
    });
  }

  return out;
}
