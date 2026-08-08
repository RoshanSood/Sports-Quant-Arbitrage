import { NextRequest, NextResponse } from "next/server";
import { isRunning, saveOpportunities, setRunning } from "@/lib/arbitrage/opportunityStore";
import { ingestTotals } from "@/lib/arbitrage/ingest";
import { matchMarkets } from "@/lib/arbitrage/matching";
import { detectArbs } from "@/lib/arbitrage/arbEngine";
import { getAgent } from "@/lib/arbitrage/agentStore";
import { getRiskSettings } from "@/lib/arbitrage/riskStore";
import { getVenues } from "@/lib/arbitrage/venueStore";
import { filterMarketsForAgent } from "@/lib/arbitrage/venueFilters";
import { DEFAULT_AGENT } from "@/lib/arbitrage/seed";
import { isAuthorized } from "@/lib/adminAuth";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function POST(request: NextRequest) {
  let body: { date?: string; password?: string; agent?: string } = {};
  try {
    body = await request.json();
  } catch {
    // body optional
  }

  if (!isAuthorized(request, body.password)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = body.date ?? todayDateStr();
  if (isRunning(date)) {
    return NextResponse.json({ status: "already-running", date });
  }

  // Fire-and-forget scan: refresh markets, derive opportunities, and persist them for
  // pollers that read the async opportunity cache.
  setRunning(date, true);
  (async () => {
    try {
      const [ingested, agent, risk, venues] = await Promise.all([
        ingestTotals(date),
        getAgent(body.agent ?? DEFAULT_AGENT.id).then((a) => a ?? DEFAULT_AGENT),
        getRiskSettings(),
        getVenues(),
      ]);
      const activeMarkets = filterMarketsForAgent(ingested.markets, venues, agent);
      const { matched } = matchMarkets(activeMarkets);
      const { opportunities } = detectArbs(matched, agent, {
        minLiquidityUsd: risk.minLiquidityUsd,
        minExpectedProfitUsd: risk.minExpectedProfitUsd,
        liquidityStakeBufferMultiple: risk.liquidityStakeBufferMultiple,
        staleDivergenceCents: risk.staleDivergenceCents,
      });
      await saveOpportunities(date, opportunities);
    } catch (e) {
      console.error(`[arbitrage/opportunities/run] ${date} failed:`, e);
    } finally {
      setRunning(date, false);
    }
  })();

  return NextResponse.json({ status: "started", date });
}
