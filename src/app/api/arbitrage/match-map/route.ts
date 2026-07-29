import { NextRequest, NextResponse } from "next/server";
import { getMarkets, isRunning } from "@/lib/arbitrage/marketStore";
import { matchMarkets } from "@/lib/arbitrage/matching";
import { pacificTodayDateStr } from "@/lib/arbitrage/date";

// Runs the matching engine over the date's ingested normalized markets and returns
// matched events + rejection stats for the Match Map panel.
export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? pacificTodayDateStr();
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
