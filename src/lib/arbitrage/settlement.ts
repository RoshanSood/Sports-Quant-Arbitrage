// Phase: settlement & reconciliation (manual §14). Auto-closes open paper positions
// once the underlying game is FINAL, computing realized P&L from the result.
//
//   - Hedged arb (both legs filled): guaranteed — realizes its expected profit.
//   - Naked position (one leg filled): graded against the final total (win/lose).
//
// Uses ESPN's public scoreboard for final status + scores. gameId is embedded in the
// leg marketId ("kalshi:<gameId>:total:<line>:<over|under>").

import type { Trade } from "@/types/arbitrage";
import { getAllTrades, updateTrade } from "./tradeStore";

// Scoreboards for every sport the arb module ingests. ESPN event ids are globally
// unique, so we merge both into one gameId→result map.
const ESPN_BASES = [
  "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb",
  "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba",
  "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1",
  "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions",
  "https://site.api.espn.com/apis/site/v2/sports/tennis/atp",
  "https://site.api.espn.com/apis/site/v2/sports/tennis/wta",
];

type GameResult = { final: boolean; away: number; home: number; total: number };
type EspnCompetitor = { homeAway?: string; score?: string | number; winner?: boolean };
type EspnCompetition = {
  id?: string | number;
  competitors?: EspnCompetitor[];
  status?: { type?: { completed?: boolean; state?: string } };
};

function shiftDate(yyyymmdd: string, deltaDays: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function fetchScoreboard(base: string, date: string, map: Map<string, GameResult>): Promise<void> {
  try {
    const res = await fetch(`${base}/scoreboard?dates=${date}&limit=50`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const ingestComp = (id: string, comp?: EspnCompetition, eventStatus?: EspnCompetition["status"]) => {
      if (!comp) return;
      const st = (comp.status?.type ?? eventStatus?.type ?? {}) as { completed?: boolean; state?: string };
      const final = st.completed === true || st.state === "post";
      const cs = comp.competitors ?? [];
      const away = cs.find((c) => c.homeAway === "away") ?? cs[0];
      const home = cs.find((c) => c.homeAway === "home") ?? cs[1];
      const aScore = scoreOrWinner(away);
      const hScore = scoreOrWinner(home);
      map.set(id, { final, away: aScore, home: hScore, total: aScore + hScore });
    };
    for (const ev of data.events ?? []) {
      const eventId = String(ev.id ?? "");
      const eventStatus = ev.status;
      for (const comp of ev.competitions ?? []) ingestComp(eventId, comp, eventStatus);
      for (const grp of ev.groupings ?? []) {
        for (const comp of grp.competitions ?? []) ingestComp(String(comp.id ?? eventId), comp, eventStatus);
      }
    }
  } catch (e) {
    console.error(`[arbitrage/settle] ESPN scoreboard ${base} ${date} failed:`, e);
  }
}

function scoreOrWinner(c?: EspnCompetitor): number {
  const score = Number(c?.score);
  if (Number.isFinite(score)) return score;
  return c?.winner === true ? 1 : 0;
}

async function fetchDailyResults(date: string): Promise<Map<string, GameResult>> {
  const map = new Map<string, GameResult>();
  // ESPN event ids are unique across sports, so merging both scoreboards is safe.
  await Promise.all(ESPN_BASES.map((base) => fetchScoreboard(base, date, map)));
  return map;
}

function parseLeg(marketId: string): { gameId: string | null; type: string; line: number | null } {
  const parts = marketId.split(":");
  const gameId = parts[1] ?? null;
  const type = parts[2] ?? "total";
  const line = parts[3] != null ? parseFloat(parts[3]) : null;
  return { gameId, type, line };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Realized P&L for a finished game. Winner depends on market type:
//   total    → over/under vs the line
//   moneyline→ home/away by final score
//   spread   → margin + signed home line
export function computeRealized(t: Trade, result: { away: number; home: number; total: number }): number {
  const { type, line } = parseLeg(t.legs[0]?.marketId ?? "");

  let winner: string;
  if (type === "moneyline") {
    winner = result.home > result.away ? "home" : result.away > result.home ? "away" : "push";
  } else if (type === "spread") {
    // line is the SIGNED home line (e.g. -1.5). Home covers when margin + line > 0.
    if (line == null) return t.expectedProfit;
    const homeMargin = result.home - result.away;
    winner = homeMargin + line > 0 ? "home" : "away";
  } else {
    if (line == null) return t.expectedProfit;
    winner = result.total > line ? "over" : result.total < line ? "under" : "push";
  }

  // Naked: only one leg filled — grade that directional bet against the winner.
  if (t.status === "naked" && t.nakedLegIndex != null) {
    const leg = t.legs[t.nakedLegIndex];
    if (!leg) return t.expectedProfit;
    const cost = round2((leg.size * leg.priceCents) / 100);
    const won = leg.outcome === winner;
    return round2(won ? leg.size - cost : -cost);
  }

  // Hedged / partial: the arb is guaranteed — one leg always wins $1/contract.
  return t.expectedProfit;
}

export type SettlementResult = { checked: number; settled: number };

// Settle every open paper position whose game is final. Safe to call repeatedly.
export async function settleFinalPositions(): Promise<SettlementResult> {
  const all = await getAllTrades();
  const open = all.filter(
    (t) => t.mode === "paper" && (t.status === "open" || t.status === "partial" || t.status === "naked")
  );
  if (open.length === 0) return { checked: 0, settled: 0 };

  // Fetch results for each relevant date (± a day to catch late/UTC-drifted games).
  const dates = new Set<string>();
  for (const t of open) {
    dates.add(t.date);
    dates.add(shiftDate(t.date, -1));
    dates.add(shiftDate(t.date, 1));
  }
  const results = new Map<string, GameResult>();
  await Promise.all(
    [...dates].map(async (d) => {
      const day = await fetchDailyResults(d);
      for (const [id, r] of day) results.set(id, r);
    })
  );

  const now = new Date().toISOString();
  let settled = 0;
  for (const t of open) {
    const { gameId } = parseLeg(t.legs[0]?.marketId ?? "");
    const r = gameId ? results.get(gameId) : undefined;
    if (!r || !r.final) continue;
    const realizedPnl = computeRealized(t, r);
    await updateTrade(t.id, t.date, {
      status: "settled",
      realizedPnl,
      closedAt: now,
      finalScore: { away: r.away, home: r.home },
    });
    settled += 1;
  }
  return { checked: open.length, settled };
}
