import { NextRequest, NextResponse } from "next/server";
import { getMarkets, isRunning } from "@/lib/arbitrage/marketStore";
import { matchMarkets } from "@/lib/arbitrage/matching";
import { detectArbs } from "@/lib/arbitrage/arbEngine";
import { getAgent } from "@/lib/arbitrage/agentStore";
import { getRiskSettings } from "@/lib/arbitrage/riskStore";
import { DEFAULT_AGENT } from "@/lib/arbitrage/seed";
import { getVenues } from "@/lib/arbitrage/venueStore";
import { filterMarketsForAgent } from "@/lib/arbitrage/venueFilters";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// Live opportunity detection: ingested markets -> matched events -> arb engine,
// gated by the agent's min/max edge. Derived on demand so quotes are always fresh.
export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? todayDateStr();
    const agentId = request.nextUrl.searchParams.get("agent") ?? DEFAULT_AGENT.id;

    const [markets, agent, risk, venues] = await Promise.all([
      getMarkets(date),
      getAgent(agentId).then((a) => a ?? DEFAULT_AGENT),
      getRiskSettings(),
      getVenues(),
    ]);

    const activeMarkets = filterMarketsForAgent(markets, venues, agent);
    const { matched } = matchMarkets(activeMarkets);
    const { opportunities, rejects, watch } = detectArbs(matched, agent, { minLiquidityUsd: risk.minLiquidityUsd, staleDivergenceCents: risk.staleDivergenceCents });

    return NextResponse.json({
      opportunities,
      rejects,
      watch,
      running: isRunning(date),
      date,
    });
  } catch (error) {
    return NextResponse.json({ opportunities: [], rejects: [], watch: [], running: false, error: String(error) }, { status: 500 });
  }
}
