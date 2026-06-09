const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";

export type InjuredPlayer = {
  name: string;
  position: string;
  status: string;
};

export type GameInjuryReport = {
  byTeam: Record<string, InjuredPlayer[]>;    // keyed by team abbreviation
  vegasLine: string | null;                    // e.g. "TOR -186"
  vegasTotal: string | null;                   // e.g. "8.5"
};

type ESPNInjuryEntry = {
  athlete?: { fullName?: string; position?: { abbreviation?: string } };
  status?: string;
};

type ESPNTeamInjury = {
  team?: { abbreviation?: string };
  injuries?: ESPNInjuryEntry[];
};

export async function fetchGameInjuryReport(gameId: string): Promise<GameInjuryReport> {
  const empty: GameInjuryReport = { byTeam: {}, vegasLine: null, vegasTotal: null };

  try {
    const res = await fetch(`${ESPN_BASE}/summary?event=${gameId}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return empty;

    const data = await res.json();

    // Injury report
    const byTeam: Record<string, InjuredPlayer[]> = {};
    const injuries: ESPNTeamInjury[] = data.injuries ?? [];
    for (const teamEntry of injuries) {
      const abbr = teamEntry.team?.abbreviation ?? "";
      if (!abbr) continue;
      byTeam[abbr] = (teamEntry.injuries ?? [])
        .filter((p) => p.athlete?.fullName)
        .map((p) => ({
          name: p.athlete!.fullName!,
          position: p.athlete?.position?.abbreviation ?? "?",
          status: p.status ?? "Unknown",
        }));
    }

    // Vegas lines from pickcenter
    const pickcenter: Record<string, unknown>[] = data.pickcenter ?? [];
    let vegasLine: string | null = null;
    let vegasTotal: string | null = null;
    if (pickcenter.length > 0) {
      const pc = pickcenter[0];
      vegasLine = (pc.details as string) ?? null;
      const ou = pc.overUnder;
      vegasTotal = ou != null ? String(ou) : null;
    }

    return { byTeam, vegasLine, vegasTotal };
  } catch {
    return empty;
  }
}
