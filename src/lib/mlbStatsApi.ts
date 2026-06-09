import {
  PitcherBasicInfo,
  PitcherSeasonStats,
  PitcherGameLogEntry,
  PitcherRecentForm,
  PitcherHand,
  FormLabel,
} from "@/types/pitcherMatchup";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

// Known ESPN abbreviation → MLB Stats API abbreviation differences
const ESPN_TO_MLB: Record<string, string> = {
  CHW: "CWS", // ESPN "CHW", MLB "CWS"
  GS:  "SFG", // ESPN "SF", sometimes "GS" for Giants
};

export function normalizeAbbr(abbr: string): string {
  const upper = abbr.toUpperCase();
  return ESPN_TO_MLB[upper] ?? upper;
}

// Convert innings pitched string ("6.2") to decimal (6.667)
export function ipToDecimal(ip: string | null | undefined): number {
  if (!ip) return 0;
  const parts = ip.split(".");
  const full = parseInt(parts[0] ?? "0", 10);
  const thirds = parseInt(parts[1] ?? "0", 10);
  return full + thirds / 3;
}

// Convert decimal back to standard IP notation
function decimalToIP(d: number): string {
  const full = Math.floor(d);
  const frac = Math.round((d - full) * 3);
  return `${full}.${frac}`;
}

// ── MLB Schedule: find pitcher IDs by team abbreviation ──────────────────────

type ScheduleEntry = {
  gamePk: number;
  teams: {
    away: {
      team: { id: number; name: string };
      probablePitcher?: { id: number; fullName: string };
    };
    home: {
      team: { id: number; name: string };
      probablePitcher?: { id: number; fullName: string };
    };
  };
};

export async function findPitcherIds(
  date: string, // YYYY-MM-DD
  awayAbbr: string,
  homeAbbr: string,
  awayPitcherName: string | null,
  homePitcherName: string | null
): Promise<{ awayId: number | null; homeId: number | null; gamePk: number | null }> {
  try {
    const url = `${MLB_BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher`;
    const res = await fetch(url, { next: { revalidate: 600 } });
    if (!res.ok) return { awayId: null, homeId: null, gamePk: null };

    const data = await res.json();
    const games: ScheduleEntry[] = data.dates?.[0]?.games ?? [];

    const awayNorm = normalizeAbbr(awayAbbr);
    const homeNorm = normalizeAbbr(homeAbbr);

    // Try matching by team name abbreviation extracted from team name
    for (const game of games) {
      const awayName = game.teams.away.team.name.toUpperCase();
      const homeName = game.teams.home.team.name.toUpperCase();

      // Simple last-word matching: "Los Angeles Angels" → "ANGELS", vs "LAA" team abbrev
      // Also try direct city/name substring matching
      const awayMatches =
        awayName.includes(awayNorm) ||
        awayNorm.includes(awayName.split(" ").pop() ?? "") ||
        teamNamesMatch(awayName, awayNorm);

      const homeMatches =
        homeName.includes(homeNorm) ||
        homeNorm.includes(homeName.split(" ").pop() ?? "") ||
        teamNamesMatch(homeName, homeNorm);

      if (awayMatches && homeMatches) {
        return {
          awayId: game.teams.away.probablePitcher?.id ?? null,
          homeId: game.teams.home.probablePitcher?.id ?? null,
          gamePk: game.gamePk,
        };
      }
    }

    // Fallback: match by pitcher name
    for (const game of games) {
      const awayPP = game.teams.away.probablePitcher;
      const homePP = game.teams.home.probablePitcher;

      const awayNameMatch =
        awayPitcherName &&
        awayPP &&
        nameSimilar(awayPP.fullName, awayPitcherName);

      const homeNameMatch =
        homePitcherName &&
        homePP &&
        nameSimilar(homePP.fullName, homePitcherName);

      if (awayNameMatch || homeNameMatch) {
        return {
          awayId: game.teams.away.probablePitcher?.id ?? null,
          homeId: game.teams.home.probablePitcher?.id ?? null,
          gamePk: game.gamePk,
        };
      }
    }

    return { awayId: null, homeId: null, gamePk: null };
  } catch {
    return { awayId: null, homeId: null, gamePk: null };
  }
}

function teamNamesMatch(mlbTeamName: string, espnAbbr: string): boolean {
  // Known mappings for tricky abbreviations
  const MAP: Record<string, string> = {
    LAA: "ANGELS",
    NYY: "YANKEES",
    NYM: "METS",
    CHC: "CUBS",
    CWS: "WHITE SOX",
    CHW: "WHITE SOX",
    TB:  "RAYS",
    SF:  "GIANTS",
    SD:  "PADRES",
    KC:  "ROYALS",
    WSH: "NATIONALS",
    ATH: "ATHLETICS",
    OAK: "ATHLETICS",
    STL: "CARDINALS",
  };
  const word = MAP[espnAbbr];
  return word ? mlbTeamName.includes(word) : false;
}

function nameSimilar(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const an = normalize(a);
  const bn = normalize(b);
  if (an === bn) return true;
  const aLast = an.split(" ").pop() ?? an;
  const bLast = bn.split(" ").pop() ?? bn;
  return aLast === bLast && aLast.length >= 4;
}

// ── Pitcher details ───────────────────────────────────────────────────────────

export async function fetchPitcherDetails(
  personId: number,
  teamName: string,
  teamAbbr: string
): Promise<PitcherBasicInfo> {
  try {
    const res = await fetch(`${MLB_BASE}/people/${personId}`, { next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const p = data.people?.[0];
    if (!p) throw new Error("No person data");

    const pitchCode = p.pitchHand?.code as string | undefined;
    const throws: PitcherHand =
      pitchCode === "R" ? "RHP" : pitchCode === "L" ? "LHP" : "Unknown";

    return {
      id: personId,
      fullName: p.fullName ?? "Unknown",
      teamName,
      teamAbbreviation: teamAbbr,
      throws,
      age: p.currentAge ?? null,
      headshot: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${personId}/headshot/67/current`,
    };
  } catch {
    return {
      id: personId,
      fullName: "Unknown",
      teamName,
      teamAbbreviation: teamAbbr,
      throws: "Unknown",
    };
  }
}

// ── Season stats ─────────────────────────────────────────────────────────────

export async function fetchPitcherSeasonStats(
  personId: number,
  season: number
): Promise<PitcherSeasonStats | null> {
  try {
    const url = `${MLB_BASE}/people/${personId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await fetch(url, { next: { revalidate: 600 } });
    if (!res.ok) return null;
    const data = await res.json();
    const splits = data.stats?.[0]?.splits ?? [];
    if (!splits.length) return null;

    const s = splits[0].stat;
    return {
      era: s.era ?? null,
      whip: s.whip ?? null,
      wins: s.wins ?? null,
      losses: s.losses ?? null,
      gamesStarted: s.gamesStarted ?? null,
      inningsPitched: s.inningsPitched ?? null,
      strikeouts: s.strikeOuts ?? null,
      walks: s.baseOnBalls ?? null,
      hitsAllowed: s.hits ?? null,
      homeRunsAllowed: s.homeRuns ?? null,
      earnedRuns: s.earnedRuns ?? null,
      battingAverageAgainst: s.avg ?? null,
      strikeoutsPer9: s.strikeoutsPer9Inn ?? null,
      walksPer9: s.walksPer9Inn ?? null,
      homeRunsPer9: s.homeRunsPer9 ?? null,
      strikeoutWalkRatio: s.strikeoutWalkRatio ?? null,
    };
  } catch {
    return null;
  }
}

// ── Game logs ─────────────────────────────────────────────────────────────────

export async function fetchPitcherGameLogs(
  personId: number,
  season: number
): Promise<PitcherGameLogEntry[]> {
  try {
    const url = `${MLB_BASE}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`;
    const res = await fetch(url, { next: { revalidate: 600 } });
    if (!res.ok) return [];
    const data = await res.json();
    const splits = data.stats?.[0]?.splits ?? [];

    return splits
      .filter((entry: Record<string, unknown>) => {
        const stat = entry.stat as Record<string, unknown> | undefined;
        // Only actual starts (has IP > 0)
        return stat && ipToDecimal(stat.inningsPitched as string) > 0;
      })
      .map((entry: Record<string, unknown>) => {
        const stat = entry.stat as Record<string, unknown>;
        const opp = (entry.opponent as { name?: string } | undefined)?.name ?? "Unknown";
        let decision: string | null = null;
        if (stat.wins && Number(stat.wins) > 0) decision = "W";
        else if (stat.losses && Number(stat.losses) > 0) decision = "L";

        return {
          date: (entry.date as string) ?? "",
          opponent: opp,
          inningsPitched: (stat.inningsPitched as string) ?? null,
          earnedRuns: Number(stat.earnedRuns) ?? null,
          hitsAllowed: Number(stat.hits) ?? null,
          walks: Number(stat.baseOnBalls) ?? null,
          strikeouts: Number(stat.strikeOuts) ?? null,
          homeRunsAllowed: Number(stat.homeRuns) ?? null,
          pitchesThrown: stat.numberOfPitches ? Number(stat.numberOfPitches) : null,
          decision,
        } as PitcherGameLogEntry;
      });
  } catch {
    return [];
  }
}

// ── Recent form computation ───────────────────────────────────────────────────

export function computeRecentForm(allLogs: PitcherGameLogEntry[]): PitcherRecentForm {
  // Sort newest-first, then take last N
  const sorted = [...allLogs].sort((a, b) => b.date.localeCompare(a.date));
  const last5 = sorted.slice(0, 5).reverse(); // oldest→newest
  const last3 = sorted.slice(0, 3).reverse();

  function summarize(starts: PitcherGameLogEntry[]) {
    if (!starts.length) return {};
    const totalIP = starts.reduce((s, g) => s + ipToDecimal(g.inningsPitched), 0);
    const totalER = starts.reduce((s, g) => s + (g.earnedRuns ?? 0), 0);
    const totalH  = starts.reduce((s, g) => s + (g.hitsAllowed ?? 0), 0);
    const totalBB = starts.reduce((s, g) => s + (g.walks ?? 0), 0);
    const totalK  = starts.reduce((s, g) => s + (g.strikeouts ?? 0), 0);
    const totalHR = starts.reduce((s, g) => s + (g.homeRunsAllowed ?? 0), 0);
    const era = totalIP > 0 ? ((totalER * 9) / totalIP).toFixed(2) : null;
    const whip = totalIP > 0 ? (((totalH + totalBB) / totalIP)).toFixed(2) : null;
    return {
      inningsPitched: totalIP > 0 ? decimalToIP(totalIP) : null,
      earnedRuns: totalER,
      strikeouts: totalK,
      walks: totalBB,
      homeRunsAllowed: totalHR,
      era,
      whip,
    };
  }

  function label(starts: PitcherGameLogEntry[]): FormLabel {
    if (!starts.length) return "Unknown";
    const totalIP = starts.reduce((s, g) => s + ipToDecimal(g.inningsPitched), 0);
    const totalER = starts.reduce((s, g) => s + (g.earnedRuns ?? 0), 0);
    if (totalIP === 0) return "Unknown";
    const era = (totalER * 9) / totalIP;
    if (era < 2.00) return "Strong";
    if (era < 3.25) return "Solid";
    if (era < 4.50) return "Average";
    if (era < 5.50) return "Volatile";
    return "Risky";
  }

  return {
    last3Starts: last3,
    last5Starts: last5,
    last3Summary: summarize(last3),
    formLabel: label(last3),
  };
}

// ── Headshot URL helper ───────────────────────────────────────────────────────

export function mlbHeadshotUrl(personId: number): string {
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${personId}/headshot/67/current`;
}
