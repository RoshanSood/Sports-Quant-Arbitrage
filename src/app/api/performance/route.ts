import { NextRequest, NextResponse } from "next/server";
import { getAllRecommendations, computeBreakdown } from "@/lib/recommendationStore";
import { getAllKalshiRecommendations } from "@/lib/kalshiRecommendationStore";
import { League, MarketType } from "@/types/performance";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const leagueParam = searchParams.get("league") as League | null;
  const marketParam = searchParams.get("market") as MarketType | null;
  const sourceParam = searchParams.get("source");
  const limitStr = searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 100;

  try {
    let recs =
      sourceParam === "kalshi"
        ? await getAllKalshiRecommendations()
        : await getAllRecommendations();

    if (leagueParam) recs = recs.filter((r) => r.league === leagueParam);
    if (marketParam) recs = recs.filter((r) => r.marketType === marketParam);

    const breakdown = computeBreakdown(recs);
    const recent = recs.slice(0, limit);

    return NextResponse.json({
      breakdown,
      recommendations: recent,
      total: recs.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load performance data" },
      { status: 500 }
    );
  }
}
