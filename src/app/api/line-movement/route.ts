import { NextRequest, NextResponse } from "next/server";
import { getSnapshotsForDate, buildMovements } from "@/lib/snapshotStore";
import { League } from "@/types/snapshots";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const today = new Date();
  const defaultDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const date = searchParams.get("date") || defaultDate;
  const leagueParam = searchParams.get("league");
  const league = (leagueParam === "MLB" || leagueParam === "WNBA") ? leagueParam as League : undefined;

  try {
    const snapshots = await getSnapshotsForDate(date, league);
    const movements = buildMovements(snapshots);

    // Enrich with start times from the games APIs (best-effort, non-blocking)
    // We look up game start times by fetching the game list for context.
    // If that fails, startTime just stays empty.
    const gameIds = [...new Set(movements.map((m) => m.gameId))];
    const startTimes = new Map<string, string>();

    if (gameIds.length > 0) {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
      const fetchTimes = async (url: string) => {
        try {
          const r = await fetch(url, { next: { revalidate: 60 } });
          if (!r.ok) return;
          const d = await r.json();
          const games = d.games ?? [];
          for (const g of games) {
            if (gameIds.includes(g.id)) startTimes.set(g.id, g.startTime ?? "");
          }
        } catch { /* ignore */ }
      };

      const mlbLeagueActive = !leagueParam || leagueParam === "MLB";
      const wnbaLeagueActive = !leagueParam || leagueParam === "WNBA";
      await Promise.all([
        mlbLeagueActive ? fetchTimes(`${baseUrl}/api/games?date=${date}`) : Promise.resolve(),
        wnbaLeagueActive ? fetchTimes(`${baseUrl}/api/wnba?date=${date}`) : Promise.resolve(),
      ]);
    }

    // Attach start times
    for (const m of movements) {
      m.startTime = startTimes.get(m.gameId) ?? "";
    }

    // Count total snapshots for each game (useful for "data richness" indicator)
    const snapshotCountByGame = new Map<string, number>();
    for (const s of snapshots) {
      snapshotCountByGame.set(s.gameId, (snapshotCountByGame.get(s.gameId) ?? 0) + 1);
    }

    return NextResponse.json({
      movements,
      date,
      totalSnapshots: snapshots.length,
      snapshotCountByGame: Object.fromEntries(snapshotCountByGame),
    });
  } catch (error) {
    console.error("[line-movement]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load movement data" },
      { status: 500 }
    );
  }
}
