import { NextRequest, NextResponse } from "next/server";
import { isRunning, saveOpportunities, setRunning } from "@/lib/arbitrage/opportunityStore";
import { isAuthorized } from "@/lib/adminAuth";
import { runIngestion } from "@/lib/arbitrage/ingest";
import { getMarkets } from "@/lib/arbitrage/marketStore";
import { matchMarkets } from "@/lib/arbitrage/matching";
import { detectArbs } from "@/lib/arbitrage/arbEngine";
import { getAgent } from "@/lib/arbitrage/agentStore";
import { getRiskSettings } from "@/lib/arbitrage/riskStore";
import { DEFAULT_AGENT } from "@/lib/arbitrage/seed";

// Protected async scan: refresh venue books, match events, and persist real arbs.

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function POST(request: NextRequest) {
  let body: { date?: string; agent?: string; password?: string } = {};
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

  // Return immediately while the client polls the read-only opportunity endpoint.
  setRunning(date, true);
  (async () => {
    try {
      const agentId = body.agent ?? DEFAULT_AGENT.id;
      await runIngestion(date);
      const [markets, agent, risk] = await Promise.all([
        getMarkets(date),
        getAgent(agentId).then((a) => a ?? DEFAULT_AGENT),
        getRiskSettings(),
      ]);
      const { matched } = matchMarkets(markets);
      const { opportunities } = detectArbs(matched, agent, risk.minLiquidityUsd);
      await saveOpportunities(date, opportunities);
    } catch (e) {
      console.error(`[arbitrage/opportunities/run] ${date} failed:`, e);
    } finally {
      setRunning(date, false);
    }
  })();

  return NextResponse.json({ status: "started", date });
}
