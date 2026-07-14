import { NextRequest, NextResponse } from "next/server";
import { getMarkets, isRunning } from "@/lib/arbitrage/marketStore";
import type { NormalizedMarket, VenueId } from "@/types/arbitrage";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? todayDateStr();
    const venue = request.nextUrl.searchParams.get("venue");
    let markets = await getMarkets(date);
    if (venue) markets = markets.filter((m) => m.venueId === venue);

    const venueCounts = markets.reduce<Record<VenueId, number>>((acc, m: NormalizedMarket) => {
      acc[m.venueId] = (acc[m.venueId] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({ markets, venueCounts, running: isRunning(date), date });
  } catch (error) {
    return NextResponse.json({ markets: [], venueCounts: {}, running: false, error: String(error) }, { status: 500 });
  }
}
