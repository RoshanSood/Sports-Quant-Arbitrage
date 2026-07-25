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

    // Trigger ingestion only when refresh=1 is explicitly requested. Plain GETs are
    // read-only so opening/reloading the page does not start scanning.
    if (refresh && !running) {
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
