import { NextRequest, NextResponse } from "next/server";
import { getAgent } from "@/lib/arbitrage/agentStore";
import { detectArbs } from "@/lib/arbitrage/arbEngine";
import { pacificTodayDateStr } from "@/lib/arbitrage/date";
import { getMarkets, isRunning } from "@/lib/arbitrage/marketStore";
import { matchMarkets } from "@/lib/arbitrage/matching";
import { getRiskSettings } from "@/lib/arbitrage/riskStore";
import { DEFAULT_AGENT } from "@/lib/arbitrage/seed";
import { buildVenueDiagnostics } from "@/lib/arbitrage/venueDiagnostics";
import { filterMarketsForAgent } from "@/lib/arbitrage/venueFilters";
import { getVenues } from "@/lib/arbitrage/venueStore";

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? pacificTodayDateStr();
    const agentId = request.nextUrl.searchParams.get("agent") ?? DEFAULT_AGENT.id;
    const [markets, agent, risk, venues] = await Promise.all([
      getMarkets(date),
      getAgent(agentId).then((a) => a ?? DEFAULT_AGENT),
      getRiskSettings(),
      getVenues(),
    ]);
    const activeMarkets = filterMarketsForAgent(markets, venues, agent);
    const { matched } = matchMarkets(activeMarkets);
    const { opportunities, rejects } = detectArbs(matched, agent, risk);
    const diagnostics = await buildVenueDiagnostics(date, activeMarkets, matched, opportunities, rejects);
    return NextResponse.json({ date, running: isRunning(date), diagnostics });
  } catch (error) {
    return NextResponse.json({ diagnostics: [], running: false, error: String(error) }, { status: 500 });
  }
}
