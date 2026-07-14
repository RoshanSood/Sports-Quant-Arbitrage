import { NextRequest, NextResponse } from "next/server";
import { getMarkets, isRunning } from "@/lib/arbitrage/marketStore";
import { matchMarkets } from "@/lib/arbitrage/matching";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// Runs the matching engine over the date's ingested normalized markets and returns
// matched events + rejection stats for the Match Map panel.
export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? todayDateStr();
    const markets = await getMarkets(date);
    const data = matchMarkets(markets);
    return NextResponse.json({ ...data, running: isRunning(date), date });
  } catch (error) {
    return NextResponse.json(
      { matched: [], rejects: [], stats: null, running: false, error: String(error) },
      { status: 500 }
    );
  }
}
