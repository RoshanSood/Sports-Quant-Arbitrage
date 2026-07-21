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
type EspnCompetitor = { homeAway?: string; team?: EspnTeam; athlete?: EspnAthlete };
type EspnStatus = { type?: { state?: string; completed?: boolean } };
type EspnCompetition = { id?: string | number; competitors?: EspnCompetitor[]; date?: string; status?: EspnStatus };
type EspnEvent = {
  id?: string | number;
  date?: string;
  status?: EspnStatus;
  competitions?: EspnCompetition[];
  groupings?: { competitions?: EspnCompetition[] }[];
};

function abbr(s: string): string {
  return s.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "??";
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
  return { id, date: (comp.date || fallbackDate).split("T")[0], awayTeam: a, homeTeam: h };
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
        const g = comp ? gameFromCompetition(comp, String(e.id ?? ""), e.date || date) : null;
        if (g) games.push(g);
      }
      return games;
    } catch (err) {
      console.error(`[espn:${path}] fixtures fetch failed:`, err);
      return [];
    }
  };
}

// Tennis scoreboard: flatten the tournament tree (groupings → competitions) into
// individual player-vs-player matches. `path` e.g. "tennis/wta".
export function espnTennisGamesFetcher(path: string): (date: string) => Promise<ArbGame[]> {
  return async (date) => {
    try {
      const events = await getScoreboard(path, date);
      const games: ArbGame[] = [];
      for (const e of events) {
        for (const grp of e.groupings ?? []) {
          for (const comp of grp.competitions ?? []) {
            const g = gameFromCompetition(comp, String(comp.id ?? `${e.id}`), comp.date || e.date || date);
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
