import { MLBGame, TeamInfo } from "@/types";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";

function formatRecord(team: Record<string, unknown>): string {
  try {
    // ESPN scoreboard uses "records" (plural array), summary API uses "record.items"
    const recordsArr = team.records as Array<{ summary?: string; type?: string; name?: string }> | undefined;
    if (recordsArr && recordsArr.length > 0) {
      const overall = recordsArr.find((r) => r.type === "total" || r.name === "overall") || recordsArr[0];
      return overall?.summary || "0-0";
    }
    const recordItems = (team as { record?: { items?: Array<{ summary?: string; type?: string }> } }).record?.items;
    if (recordItems && recordItems.length > 0) {
      const overall = recordItems.find((r) => r.type === "total") || recordItems[0];
      return overall?.summary || "0-0";
    }
    return "0-0";
  } catch {
    return "0-0";
  }
}

type ESPNProbable = {
  athlete?: { fullName?: string; team?: { id?: string } };
  abbreviation?: string;
  statistics?: Array<{ name?: string; abbreviation?: string; displayValue?: string }>;
  record?: string;
};

function extractPitcherInfo(competitor: Record<string, unknown>): {
  name: string | null;
  stats: string | null;
} {
  try {
    const probables = competitor.probables as ESPNProbable[] | undefined;
    if (!probables || probables.length === 0) return { name: null, stats: null };

    const sp = probables.find((p) => p.abbreviation === "SP") ?? probables[0];
    const name = sp?.athlete?.fullName ?? null;

    // Build "W-L, ERA" string from the statistics array
    let stats: string | null = null;
    if (sp?.statistics && sp.statistics.length > 0) {
      const stat = (abbr: string) =>
        sp.statistics!.find((s) => s.abbreviation === abbr)?.displayValue;
      const w = stat("W");
      const l = stat("L");
      const era = stat("ERA");
      if (w != null && l != null && era != null) {
        stats = `${w}-${l}, ${era} ERA`;
      } else if (sp.record) {
        stats = sp.record.replace(/[()]/g, "").trim();
      }
    } else if (sp?.record) {
      stats = sp.record.replace(/[()]/g, "").trim();
    }

    return { name, stats };
  } catch {
    return { name: null, stats: null };
  }
}

function parseCompetitor(competitor: Record<string, unknown>): TeamInfo {
  const team = (competitor.team as Record<string, unknown>) ?? {};
  const { name: pitcher, stats: pitcherStats } = extractPitcherInfo(competitor);
  return {
    id: (team.id as string) ?? "",
    name: (team.displayName as string) ?? (team.name as string) ?? "Unknown",
    shortName: (team.shortDisplayName as string) ?? (team.name as string) ?? "Unknown",
    abbreviation: (team.abbreviation as string) ?? "??",
    logo:
      (team.logo as string) ??
      `https://a.espncdn.com/i/teamlogos/mlb/500/${((team.abbreviation as string) || "mlb").toLowerCase()}.png`,
    record: formatRecord(competitor),
    pitcher,
    pitcherStats,
  };
}

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
      hour12: true,
    });
  } catch {
    return "TBD";
  }
}

export async function fetchESPNGames(date: string): Promise<MLBGame[]> {
  // date format: YYYYMMDD
  const url = `${ESPN_BASE}/scoreboard?dates=${date}&limit=50`;
  const res = await fetch(url, { next: { revalidate: 60 } });

  if (!res.ok) {
    throw new Error(`ESPN API error: ${res.status}`);
  }

  const data = await res.json();
  const events: Record<string, unknown>[] = data.events || [];

  return events.map((event) => {
    const competitions = (event.competitions as Record<string, unknown>[]) || [];
    const competition = competitions[0] || {};
    const competitors = (competition.competitors as Record<string, unknown>[]) || [];

    const away = competitors.find((c) => (c as { homeAway?: string }).homeAway === "away") || competitors[0] || {};
    const home = competitors.find((c) => (c as { homeAway?: string }).homeAway === "home") || competitors[1] || {};

    const status = (event.status as { type?: { description?: string } })?.type?.description || "Scheduled";

    return {
      id: event.id as string,
      date: (event.date as string)?.split("T")[0] || date,
      startTimeIso: (event.date as string) || "",
      startTime: formatTime(event.date as string),
      status,
      awayTeam: parseCompetitor(away as Record<string, unknown>),
      homeTeam: parseCompetitor(home as Record<string, unknown>),
      market: null,
    };
  });
}

export async function fetchESPNGame(gameId: string): Promise<MLBGame | null> {
  const url = `${ESPN_BASE}/summary?event=${gameId}`;
  const res = await fetch(url, { next: { revalidate: 60 } });

  if (!res.ok) return null;

  const data = await res.json();

  const header = data.header || {};
  const competitions = header.competitions || [];
  const competition = competitions[0] || {};
  const competitors = (competition.competitors as Record<string, unknown>[]) || [];

  const away = competitors.find((c) => (c as { homeAway?: string }).homeAway === "away") || competitors[0] || {};
  const home = competitors.find((c) => (c as { homeAway?: string }).homeAway === "home") || competitors[1] || {};

  const status = (competition.status as { type?: { description?: string } })?.type?.description || "Scheduled";
  const dateStr = (competition.date as string) || "";

  return {
    id: gameId,
    date: dateStr.split("T")[0] || "",
    startTimeIso: dateStr,
    startTime: formatTime(dateStr),
    status,
    awayTeam: parseCompetitor(away as Record<string, unknown>),
    homeTeam: parseCompetitor(home as Record<string, unknown>),
    market: null,
  };
}
