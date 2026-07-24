import { NextRequest, NextResponse } from "next/server";
import { getLogs } from "@/lib/arbitrage/arbLogStore";
import { getAllTrades, getTradesByDate } from "@/lib/arbitrage/tradeStore";
import type { ArbLog, ExecutionStep, Trade } from "@/types/arbitrage";

function hasTradeId(log: ArbLog, tradeId: string): boolean {
  return log.detailsJson?.tradeId === tradeId;
}

function sameOpportunity(log: ArbLog, trade: Trade): boolean {
  return log.detailsJson?.opportunityId === trade.opportunityId;
}

function sameTradeWindow(log: ArbLog, trade: Trade): boolean {
  const opened = Date.parse(trade.openedAt);
  const time = Date.parse(log.time);
  return log.pair.includes(trade.matchup) && Math.abs(time - opened) < 60_000;
}

function fallbackSteps(logs: ArbLog[], trade: Trade): ExecutionStep[] {
  if (trade.executionSteps?.length) return trade.executionSteps;
  const latest = logs[0];
  const steps = latest?.detailsJson?.pipelineSteps;
  if (Array.isArray(steps)) return steps as ExecutionStep[];
  if (!latest) return [];
  return [
    {
      key: latest.reasonCode ?? "execution",
      label: latest.result,
      status: latest.result === "executed" ? "pass" : latest.result === "partial" ? "warn" : "halt",
      detail: latest.reason,
    },
  ];
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const date = request.nextUrl.searchParams.get("date") ?? undefined;
    const trades = date ? await getTradesByDate(date) : await getAllTrades();
    const trade = trades.find((t) => t.id === id);
    if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });

    const logs = (await getLogs(date ?? trade.date))
      .filter((log) => hasTradeId(log, trade.id) || sameOpportunity(log, trade) || sameTradeWindow(log, trade))
      .sort((a, b) => b.time.localeCompare(a.time));
    const latest = logs[0] ?? null;

    return NextResponse.json({
      trade,
      logs,
      postFill: trade.postFill ?? latest?.detailsJson?.postFill ?? null,
      executionSteps: fallbackSteps(logs, trade),
      orders: latest?.detailsJson?.orders ?? [],
      reconciliation: latest?.detailsJson?.reconciliation ?? [],
      storage: {
        tradeStore: `data/arbitrage/trades/${trade.date}.json`,
        logStore: `data/arbitrage/logs/${trade.date}.json`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
