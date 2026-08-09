// Generic ESPN scoreboard fixtures for the arbitrage pipeline. Returns the minimal
// ArbGame shape (id + date + home/away identity) the venue adapters match against by
// team/player name. Two page shapes:
//   • team sports (soccer): events[].competitions[0].competitors[] (homeAway + team)
//   • tennis:               events[] are TOURNAMENTS; matches live under
//                           events[].groupings[].competitions[].competitors[] (athletes)
// All reads are public (no key) and never throw — a failure yields an empty fixture list.

import type { ArbGame } from "./arbitrage/sports";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

type EspnTeam = { displayName?: string; shortDisplayName?: string; name?: string; abbreviation?: string };
type EspnAthlete = { displayName?: string; shortName?: string; fullName?: string };
type EspnCompetitor = { homeAway?: string; team?: EspnTeam; athlete?: EspnAthlete; score?: string | number };
type EspnStatus = { period?: number; type?: { state?: string; completed?: boolean; shortDetail?: string } };
type EspnCompetition = { id?: string | number; competitors?: EspnCompetitor[]; date?: string; status?: EspnStatus };
type EspnEvent = {
  id?: string | number;
  date?: string;
  status?: EspnStatus;
  competitions?: EspnCompetition[];
  // ESPN nests a tennis tournament's brackets — men's/women's singles AND doubles — under
  // ONE shared event when a tour stop is co-hosted (e.g. National Bank Open runs ATP+WTA
  // the same week). `grouping.slug` ("mens-singles" | "womens-singles" | "*-doubles") is
  // the only field that tells them apart — there is nothing else per-competition.
  groupings?: { grouping?: { slug?: string }; competitions?: EspnCompetition[] }[];
};

function abbr(s: string): string {
  return s.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "??";
}

function slateDate(date: string): string {
  return date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
}

function competitorInfo(c?: EspnCompetitor): ArbGame["homeTeam"] | null {
  if (!c) return null;
  if (c.team) {
    const name = c.team.displayName || c.team.name;
    if (!name) return null;
    return { name, shortName: c.team.shortDisplayName || c.team.name || name, abbreviation: c.team.abbreviation || abbr(name) };
  }
  if (c.athlete) {
    const name = c.athlete.displayName || c.athlete.fullName;
    if (!name) return null;
    return { name, shortName: c.athlete.shortName || name, abbreviation: abbr(name) };
  }
  return null;
}

// Skip finished matches — we only arb upcoming/live events.
function notCompleted(s?: EspnStatus): boolean {
  return s?.type?.completed !== true && s?.type?.state !== "post";
}

async function getScoreboard(path: string, date?: string): Promise<EspnEvent[]> {
  const url = `${ESPN}/${path}/scoreboard${date ? `?dates=${date}&limit=100` : "?limit=100"}`;
  const res = await fetch(url, { next: { revalidate: 60 } });
  if (!res.ok) return [];
  const j = (await res.json()) as { events?: EspnEvent[] };
  return j.events ?? [];
}

function gameFromCompetition(comp: EspnCompetition, id: string, fallbackDate: string): ArbGame | null {
  if (!notCompleted(comp.status)) return null;
  const cs = comp.competitors ?? [];
  if (cs.length < 2) return null;
  const away = cs.find((c) => c.homeAway === "away") ?? cs[1];
  const home = cs.find((c) => c.homeAway === "home") ?? cs[0];
  const a = competitorInfo(away);
  const h = competitorInfo(home);
  if (!a || !h) return null;
  return { id, date: slateDate(fallbackDate), awayTeam: a, homeTeam: h };
}

// Team-sport scoreboard (soccer: one match per event). `path` e.g. "soccer/usa.1".
export function espnTeamGamesFetcher(path: string): (date: string) => Promise<ArbGame[]> {
  return async (date) => {
    try {
      const events = await getScoreboard(path, date);
      const games: ArbGame[] = [];
      for (const e of events) {
        if (!notCompleted(e.status)) continue;
        const comp = (e.competitions ?? [])[0];
        const g = comp ? gameFromCompetition(comp, String(e.id ?? ""), date) : null;
        if (g) games.push(g);
      }
      return games;
    } catch (err) {
      console.error(`[espn:${path}] fixtures fetch failed:`, err);
      return [];
    }
  };
}

// Live score of a mapped game (team sports). `state`: pre/in/post; `detail` is ESPN's
// short status string ("Bot 5th", "Final", "7:00 PM").
export type GameScore = {
  id: string;
  sport: string;
  league: string;
  away: { name: string; abbr: string; score: number };
  home: { name: string; abbr: string; score: number };
  state: "pre" | "in" | "post";
  period: number; // current period/quarter/inning (basketball fires per-quarter, not per-point)
  detail: string;
};

function toScore(v: string | number | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Live scores for a team-sport scoreboard (`path` e.g. "baseball/mlb", "soccer/usa.1").
// Keyed by ESPN event id — the same id the fixtures use — so the client can match to the
// games the engine mapped. Never throws.
export async function fetchEspnScores(path: string, sport: string, league: string): Promise<GameScore[]> {
  try {
    const events = await getScoreboard(path);
    const out: GameScore[] = [];
    for (const e of events) {
      const comp = (e.competitions ?? [])[0];
      const cs = comp?.competitors ?? [];
      if (cs.length < 2) continue;
      const away = cs.find((c) => c.homeAway === "away") ?? cs[1];
      const home = cs.find((c) => c.homeAway === "home") ?? cs[0];
      const a = competitorInfo(away);
      const h = competitorInfo(home);
      if (!a || !h) continue;
      const state = (e.status?.type?.state as GameScore["state"]) ?? "pre";
      out.push({
        id: String(e.id ?? ""),
        sport,
        league,
        away: { name: a.name, abbr: a.abbreviation, score: toScore(away?.score) },
        home: { name: h.name, abbr: h.abbreviation, score: toScore(home?.score) },
        state: state === "in" || state === "post" ? state : "pre",
        period: Number(e.status?.period) || 0,
        detail: e.status?.type?.shortDetail ?? "",
      });
    }
    return out;
  } catch (err) {
    console.error(`[espn:${path}] scores fetch failed:`, err);
    return [];
  }
}

// Tennis scoreboard: flatten the tournament tree (groupings → competitions) into
// individual player-vs-player matches. `path` e.g. "tennis/wta".
//
// Co-hosted stops (ATP+WTA the same week, e.g. National Bank Open) put BOTH tours' brackets
// under one ESPN event — querying either "tennis/atp" or "tennis/wta" returns the exact same
// event with groupings for men's-singles, women's-singles, men's-doubles, AND women's-doubles
// all present. Filtering only by path was a live bug: it silently mixed men's matches into
// the WTA fixture list (and vice versa) and pulled in DOUBLES matches (2-a-side, a different
// market entirely) alongside singles — verified live 2026-08-09 against the National Bank
// Open event, which listed 111 men's-singles + 111 women's-singles + 31/31 doubles
// competitions all under both the /atp and /wta scoreboard responses. Must filter to exactly
// the singles bracket for the tour this fetcher was built for.
function expectedSinglesSlug(path: string): "mens-singles" | "womens-singles" | null {
  if (path.endsWith("/atp")) return "mens-singles";
  if (path.endsWith("/wta")) return "womens-singles";
  return null; // unknown tour — filtering can't be trusted, so skip everything rather than guess
}

export function espnTennisGamesFetcher(path: string): (date: string) => Promise<ArbGame[]> {
  const wantSlug = expectedSinglesSlug(path);
  return async (date) => {
    if (!wantSlug) return [];
    try {
      const events = await getScoreboard(path, date);
      const games: ArbGame[] = [];
      for (const e of events) {
        for (const grp of e.groupings ?? []) {
          if (grp.grouping?.slug !== wantSlug) continue;
          for (const comp of grp.competitions ?? []) {
            const g = gameFromCompetition(comp, String(comp.id ?? `${e.id}`), date);
            if (g) games.push(g);
          }
        }
      }
      return games;
    } catch (err) {
      console.error(`[espn:${path}] fixtures fetch failed:`, err);
      return [];
    }
  };
}
