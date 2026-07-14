import { NextRequest, NextResponse } from "next/server";
import { getAllTrades } from "@/lib/arbitrage/tradeStore";
import { getRiskSettings } from "@/lib/arbitrage/riskStore";
import type { PortfolioSummary, TradeMode } from "@/types/arbitrage";

const STARTING_BANKROLL = 10000;

export async function GET(request: NextRequest) {
  try {
    const mode = (request.nextUrl.searchParams.get("mode") as TradeMode | null) ?? "paper";
    const all = await getAllTrades();
    const rows = all.filter((t) => t.mode === mode);
    const risk = await getRiskSettings();

    const open = rows.filter((t) => t.status === "open" || t.status === "partial" || t.status === "naked");
    const closed = rows.filter((t) => t.status === "settled" || t.status === "closed");
    const realized = rows.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const unrealized = open.reduce((s, t) => s + t.expectedProfit, 0);
    const exposure = open.reduce((s, t) => s + t.totalCost, 0);
    const wins = closed.filter((t) => (t.realizedPnl ?? 0) > 0).length;

    const summary: PortfolioSummary = {
      mode,
      bankroll: STARTING_BANKROLL + realized,
      startingBankroll: STARTING_BANKROLL,
      totalPnl: realized,
      unrealizedPnl: unrealized,
      exposure,
      maxExposure: risk.maxExposure,
      openCount: open.length,
      totalCount: rows.length,
      winRate: closed.length ? wins / closed.length : 1,
      maxPerArb: 50,
      positions: rows,
    };
    return NextResponse.json({ portfolio: summary });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
