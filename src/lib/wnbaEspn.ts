import { WNBAGame, WNBATeamInfo, InjuredPlayer } from "@/types/wnba";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba";

type ESPNCompetitor = Record<string, unknown>;

function formatRecord(competitor: ESPNCompetitor): string {
  try {
    const records = competitor.records as Array<{ summary?: string; type?: string; name?: string }> | undefined;
    if (records && records.length > 0) {
      const overall = records.find((r) => r.type === "total" || r.name === "overall") ?? records[0];
      return overall?.summary ?? "0-0";
    }
    return "0-0";
  } catch {
    return "0-0";
  }
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

function parseCompetitor(competitor: ESPNCompetitor): Omit<WNBATeamInfo, "injuries"> {
  const team = (competitor.team as Record<string, unknown>) ?? {};
  const abbr = (team.abbreviation as string) ?? "??";
  return {
    id: (team.id as string) ?? "",
    name: (team.displayName as string) ?? (team.name as string) ?? "Unknown",
    shortName: (team.shortDisplayName as string) ?? (team.name as string) ?? "Unknown",
    abbreviation: abbr,
    logo:
      (team.logo as string) ??
      `https://a.espncdn.com/i/teamlogos/wnba/500/${abbr.toLowerCase()}.png`,
    record: formatRecord(competitor),
  };
}

type ESPNInjury = {
  athlete?: {
    fullName?: string;
    position?: { abbreviation?: string };
  };
  status?: string;
  type?: { description?: string };
};

type ESPNTeamInjury = {
  team?: { id?: string; displayName?: string; abbreviation?: string };
  injuries?: ESPNInjury[];
};

async function fetchInjuries(gameId: string): Promise<Map<string, InjuredPlayer[]>> {
  try {
    const res = await fetch(`${ESPN_BASE}/summary?event=${gameId}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return new Map();
    const data = await res.json();
    const injuryMap = new Map<string, InjuredPlayer[]>();

    const rawInjuries: ESPNTeamInjury[] = data.injuries ?? [];
    for (const teamEntry of rawInjuries) {
      const teamId = teamEntry.team?.id ?? "";
      const players: InjuredPlayer[] = (teamEntry.injuries ?? [])
        .filter((p) => p.athlete?.fullName)
        .map((p) => ({
          name: p.athlete!.fullName!,
          position: p.athlete?.position?.abbreviation ?? "—",
          status: p.status ?? p.type?.description ?? "Out",
        }));
      if (teamId) injuryMap.set(teamId, players);
    }
    return injuryMap;
  } catch {
    return new Map();
  }
}

export async function fetchWNBAGames(date: string): Promise<WNBAGame[]> {
  const url = `${ESPN_BASE}/scoreboard?dates=${date}&limit=50`;
  const res = await fetch(url, { next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`ESPN WNBA API error: ${res.status}`);

  const data = await res.json();
  const events: Record<string, unknown>[] = data.events ?? [];

  // Fetch injuries concurrently for all games
  const injuryMaps = await Promise.all(
    events.map((e) => fetchInjuries(e.id as string))
  );

  return events.map((event, idx) => {
    const competitions = (event.competitions as Record<string, unknown>[]) ?? [];
    const competition = competitions[0] ?? {};
    const competitors = (competition.competitors as ESPNCompetitor[]) ?? [];

    const away = competitors.find((c) => (c as { homeAway?: string }).homeAway === "away") ?? competitors[0] ?? {};
    const home = competitors.find((c) => (c as { homeAway?: string }).homeAway === "home") ?? competitors[1] ?? {};

    const awayBase = parseCompetitor(away);
    const homeBase = parseCompetitor(home);
    const injuryMap = injuryMaps[idx];

    const status =
      (event.status as { type?: { description?: string } })?.type?.description ?? "Scheduled";

    return {
      id: event.id as string,
      date: (event.date as string)?.split("T")[0] ?? date,
      startTime: formatTime(event.date as string),
      status,
      awayTeam: { ...awayBase, injuries: injuryMap.get(awayBase.id) ?? [] },
      homeTeam: { ...homeBase, injuries: injuryMap.get(homeBase.id) ?? [] },
      market: null,
    };
  });
}

export async function fetchWNBAGame(gameId: string): Promise<WNBAGame | null> {
  try {
    const [summaryRes, injuryMap] = await Promise.all([
      fetch(`${ESPN_BASE}/summary?event=${gameId}`, { next: { revalidate: 60 } }),
      fetchInjuries(gameId),
    ]);
    if (!summaryRes.ok) return null;
    const data = await summaryRes.json();

    const header = data.header ?? {};
    const competition = (header.competitions ?? [])[0] ?? {};
    const competitors: ESPNCompetitor[] = competition.competitors ?? [];

    const away = competitors.find((c) => (c as { homeAway?: string }).homeAway === "away") ?? competitors[0] ?? {};
    const home = competitors.find((c) => (c as { homeAway?: string }).homeAway === "home") ?? competitors[1] ?? {};

    const awayBase = parseCompetitor(away);
    const homeBase = parseCompetitor(home);
    const status = (competition.status as { type?: { description?: string } })?.type?.description ?? "Scheduled";
    const dateStr = (competition.date as string) ?? "";

    return {
      id: gameId,
      date: dateStr.split("T")[0] ?? "",
      startTime: formatTime(dateStr),
      status,
      awayTeam: { ...awayBase, injuries: injuryMap.get(awayBase.id) ?? [] },
      homeTeam: { ...homeBase, injuries: injuryMap.get(homeBase.id) ?? [] },
      market: null,
    };
  } catch {
    return null;
  }
}
