import { NextResponse } from "next/server";
import { fetchEspnScores } from "@/lib/espnSports";
import { SPORTS } from "@/lib/arbitrage/sports";

// Live scores for every configured team sport, keyed by ESPN event id (the same id the
// fixtures/markets use). The client diffs these to flash score changes for the games the
// engine currently maps. Public ESPN reads — no credentials, never throws.
export async function GET() {
  try {
    const parts = await Promise.all(
      SPORTS.filter((s) => s.espnScorePath).map((s) =>
        fetchEspnScores(s.espnScorePath!, s.sport, s.league).catch(() => [])
      )
    );
    return NextResponse.json({ scores: parts.flat() });
  } catch (error) {
    return NextResponse.json({ scores: [], error: String(error) }, { status: 500 });
  }
}
