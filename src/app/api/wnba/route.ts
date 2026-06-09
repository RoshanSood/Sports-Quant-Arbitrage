import { NextRequest, NextResponse } from "next/server";
import { fetchWNBAGames } from "@/lib/wnbaEspn";
import { fetchWNBAPolymarketData } from "@/lib/wnbaPolymarket";
import { fetchKalshiWnbaData } from "@/lib/kalshiWnba";
import { WNBAGame, WNBAGamesResponse } from "@/types/wnba";
import { saveSnapshots, snapshotsFromWNBAGame } from "@/lib/snapshotStore";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const today = new Date();
  const defaultDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const date = searchParams.get("date") || defaultDate;
  const source = searchParams.get("source") === "kalshi" ? "kalshi" : "polymarket";

  try {
    const games = await fetchWNBAGames(date);
    const marketMap =
      source === "kalshi"
        ? await fetchKalshiWnbaData(games)
        : await fetchWNBAPolymarketData(games);

    const enriched: WNBAGame[] = games.map((game) => ({
      ...game,
      market: marketMap.get(game.id) ?? null,
    }));

    // Fire-and-forget snapshot capture
    const snapshots = enriched.flatMap((g) => snapshotsFromWNBAGame(g, date));
    saveSnapshots(snapshots).catch((e) => console.error("[snapshots]", e));

    const response: WNBAGamesResponse = { games: enriched, date };
    return NextResponse.json(response, { headers: { "X-Market-Source": source } });
  } catch (error) {
    console.error("WNBA games API error:", error);
    const response: WNBAGamesResponse = {
      games: [],
      date,
      error: error instanceof Error ? error.message : "Failed to fetch WNBA games",
    };
    return NextResponse.json(response, { status: 500 });
  }
}
