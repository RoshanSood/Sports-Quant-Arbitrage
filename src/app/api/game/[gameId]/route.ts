import { NextRequest, NextResponse } from "next/server";
import { fetchESPNGame } from "@/lib/espn";
import { fetchPolymarketData } from "@/lib/polymarket";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params;

  try {
    const game = await fetchESPNGame(gameId);
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    const marketMap = await fetchPolymarketData([game]);
    game.market = marketMap.get(gameId) || null;

    return NextResponse.json({ game });
  } catch (error) {
    console.error("Game detail API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch game" },
      { status: 500 }
    );
  }
}
