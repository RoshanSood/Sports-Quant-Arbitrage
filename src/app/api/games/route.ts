import { NextRequest, NextResponse } from "next/server";
import { fetchESPNGames } from "@/lib/espn";
import { fetchPolymarketData } from "@/lib/polymarket";
import { fetchKalshiData } from "@/lib/kalshi";
import { GamesResponse, MLBGame } from "@/types";
import { saveSnapshots, snapshotsFromMLBGame } from "@/lib/snapshotStore";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const today = new Date();
  const defaultDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const date = searchParams.get("date") || defaultDate;
  const source = searchParams.get("source") === "kalshi" ? "kalshi" : "polymarket";

  try {
    const games = await fetchESPNGames(date);

    let marketMap: Awaited<ReturnType<typeof fetchPolymarketData>>;
    if (source === "kalshi") {
      // Fetch Polymarket first to get spread direction, then use it as a hint for Kalshi
      // so both platforms show the same team as -1.5.
      const polymarketMap = await fetchPolymarketData(games);
      const spreadHints = new Map<string, { abbr: string; line: number }>();
      for (const [gameId, m] of polymarketMap) {
        if (m.spread.length > 0) {
          // Label is like "SEA -1.5" or "NYM +1.5" — extract team and line magnitude
          const match = m.spread[0].label.match(/^(\S+)\s+[+-](\d+(?:\.\d+)?)$/);
          if (match) spreadHints.set(gameId, { abbr: match[1], line: parseFloat(match[2]) });
        }
      }
      marketMap = await fetchKalshiData(games, spreadHints);
    } else {
      marketMap = await fetchPolymarketData(games);
    }

    const enriched: MLBGame[] = games.map((game) => ({
      ...game,
      market: marketMap.get(game.id) || null,
    }));

    // Fire-and-forget snapshot capture — doesn't block the response
    const snapshots = enriched.flatMap((g) => snapshotsFromMLBGame(g, date));
    saveSnapshots(snapshots).catch((e) => console.error("[snapshots]", e));

    const response: GamesResponse = { games: enriched, date };
    return NextResponse.json(response, { headers: { "X-Market-Source": source } });
  } catch (error) {
    console.error("Games API error:", error);
    const response: GamesResponse = {
      games: [],
      date,
      error: error instanceof Error ? error.message : "Failed to fetch games",
    };
    return NextResponse.json(response, { status: 500 });
  }
}
