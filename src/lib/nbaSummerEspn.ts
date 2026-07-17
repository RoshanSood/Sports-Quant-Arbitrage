import type { ArbGame } from "./arbitrage/sports";

const ESPN_BASE =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/nba-summer-las-vegas";

type ESPNTeam = {
  displayName?: string;
  shortDisplayName?: string;
  name?: string;
  abbreviation?: string;
};

type ESPNCompetitor = {
  homeAway?: "home" | "away";
  team?: ESPNTeam;
};

type ESPNEvent = {
  id?: string;
  date?: string;
  status?: { type?: { description?: string } };
  competitions?: Array<{ competitors?: ESPNCompetitor[] }>;
};

type ESPNScoreboard = { events?: ESPNEvent[] };

function participant(competitor: ESPNCompetitor | undefined) {
  const team = competitor?.team ?? {};
  const name = team.displayName ?? team.name ?? "Unknown";
  return {
    name,
    shortName: team.shortDisplayName ?? team.name ?? name,
    abbreviation: team.abbreviation ?? name.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 6),
  };
}

export function parseNbaSummerScoreboard(
  payload: ESPNScoreboard,
  requestedDate: string
): ArbGame[] {
  return (payload.events ?? []).flatMap((event) => {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    const away = competitors.find((competitor) => competitor.homeAway === "away");
    const home = competitors.find((competitor) => competitor.homeAway === "home");
    if (!event.id || !event.date || !away || !home) return [];

    return [
      {
        id: `nba-summer-${event.id}`,
        date: event.date.slice(0, 10) || requestedDate,
        startTimeIso: event.date,
        status: event.status?.type?.description ?? "Scheduled",
        awayTeam: participant(away),
        homeTeam: participant(home),
      },
    ];
  });
}

export async function fetchNbaSummerGames(date: string): Promise<ArbGame[]> {
  const scoreboardDate = date.replaceAll("-", "");
  const response = await fetch(
    `${ESPN_BASE}/scoreboard?dates=${encodeURIComponent(scoreboardDate)}&limit=50`,
    { next: { revalidate: 60 } }
  );
  if (!response.ok) throw new Error(`ESPN NBA Summer League API error: ${response.status}`);
  return parseNbaSummerScoreboard((await response.json()) as ESPNScoreboard, date);
}
