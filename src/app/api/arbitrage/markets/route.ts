import { NextRequest, NextResponse } from "next/server";
import { getMarkets, isRunning } from "@/lib/arbitrage/marketStore";
import { runIngestion } from "@/lib/arbitrage/ingest";
import type { NormalizedMarket, VenueId } from "@/types/arbitrage";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? todayDateStr();
    const venue = request.nextUrl.searchParams.get("venue");
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    let markets = await getMarkets(date);
    let running = isRunning(date);

    // Auto-trigger ingestion server-side when there's no cached data yet (or when a
    // refresh is requested) — no admin password needed, so live markets load in
    // production and can be re-scanned (mirrors props/bootstrap).
    if ((markets.length === 0 || refresh) && !running) {
      runIngestion(date).catch((e) => console.error(`[arbitrage/markets] ${date} ingestion failed:`, e));
      running = true;
    }

    if (venue) markets = markets.filter((m) => m.venueId === venue);
    const venueCounts = markets.reduce<Record<VenueId, number>>((acc, m: NormalizedMarket) => {
      acc[m.venueId] = (acc[m.venueId] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({ markets, venueCounts, running, date });
  } catch (error) {
    return NextResponse.json({ markets: [], venueCounts: {}, running: false, error: String(error) }, { status: 500 });
  }
}
