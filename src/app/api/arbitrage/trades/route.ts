import { NextRequest, NextResponse } from "next/server";
import { getAllTrades, getTradesByDate, updateTrade } from "@/lib/arbitrage/tradeStore";
import { settledPnl } from "@/lib/arbitrage/executionPipeline";
import { runExecution } from "@/lib/arbitrage/execution/executor";
import { extractCredsFromHeaders } from "@/lib/kalshiAuth";
import { extractOnchainCredsFromHeaders } from "@/lib/arbitrage/execution/onchainCreds";
import type { Trade, TradeMode } from "@/types/arbitrage";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date");
    const mode = request.nextUrl.searchParams.get("mode") as TradeMode | null;
    let trades = date ? await getTradesByDate(date) : await getAllTrades();
    if (mode) trades = trades.filter((t) => t.mode === mode);
    return NextResponse.json({ trades });
  } catch (error) {
    return NextResponse.json({ trades: [], error: String(error) }, { status: 500 });
  }
}

// Execute an opportunity through the full pipeline. Paper requests run dry-run (simulated).
// A "live" request passes through the execution gate (agent Live toggle,
// stake cap, adapter credentials) — if any switch fails the trade is
// reported FAILED with the blocking reasons and NO order is placed. A live request is never
// silently downgraded to a paper trade.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { opportunityId?: string; date?: string; mode?: TradeMode };
    if (!body.opportunityId) {
      return NextResponse.json({ error: "Missing opportunityId" }, { status: 400 });
    }
    const requestedMode = body.mode === "live" ? "live" : "dry_run";
    const date = body.date ?? todayDateStr();
    // Venue creds forwarded from the browser (localStorage → headers); undefined falls
    // back to server env inside each adapter. Used transiently, never persisted/logged.
    const kalshiCreds = extractCredsFromHeaders(request.headers);
    const onchain = extractOnchainCredsFromHeaders(request.headers);
    const outcome = await runExecution(body.opportunityId, date, requestedMode, { kalshiCreds, ...onchain });
    return NextResponse.json({
      ok: outcome.result !== "halted",
      result: outcome.result,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      trade: outcome.trade,
      mode: outcome.mode, // effective mode: "live" if it fired live, "dry_run" if paper
      // A live request that couldn't fire: reasonCode "live_blocked" + the reasons here.
      // No paper fallback — the trade FAILED.
      blocked: outcome.reasonCode === "live_blocked",
      blockers: outcome.blockers,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// Settle or update a position. When status=settled without an explicit realizedPnl,
// compute it from the position (guaranteed arbs realize their expected profit).
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: string; date?: string } & Partial<Trade>;
    if (!body.id || !body.date) {
      return NextResponse.json({ error: "Missing id or date" }, { status: 400 });
    }
    const { id, date, ...updates } = body;

    if (updates.status === "settled" && updates.realizedPnl == null) {
      const all = await getTradesByDate(date);
      const t = all.find((x) => x.id === id);
      if (t) {
        updates.realizedPnl = settledPnl(t);
        updates.closedAt = new Date().toISOString();
      }
    }

    const ok = await updateTrade(id, date, updates);
    if (!ok) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
