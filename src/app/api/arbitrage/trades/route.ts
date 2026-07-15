import { NextRequest, NextResponse } from "next/server";
import { getAllTrades, getTradesByDate, updateTrade } from "@/lib/arbitrage/tradeStore";
import { runExecution } from "@/lib/arbitrage/execution/executor";
import { isAuthorized } from "@/lib/adminAuth";
import { extractCredsFromHeaders } from "@/lib/kalshiAuth";
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

// Execute an opportunity through the full pipeline. Paper requests run dry-run; a
// "live" request additionally requires admin auth AND passes through the execution
// gate (env flags, venue allowlist, stake cap, kill switch, adapter credentials) —
// if any live gate fails it halts explicitly and reports the blockers.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { opportunityId?: string; date?: string; mode?: TradeMode; password?: string };
    if (!body.opportunityId) {
      return NextResponse.json({ error: "Missing opportunityId" }, { status: 400 });
    }
    const requestedMode = body.mode === "live" ? "live" : "dry_run";
    if (!isAuthorized(request, body.password)) {
      return NextResponse.json({ error: "Execution requires admin authorization" }, { status: 401 });
    }
    const date = body.date ?? todayDateStr();
    // Kalshi creds forwarded from the browser (localStorage → headers); undefined
    // falls back to server env inside the adapter.
    const kalshiCreds = extractCredsFromHeaders(request.headers);
    const outcome = await runExecution(body.opportunityId, date, requestedMode, { kalshiCreds });
    return NextResponse.json({
      ok: outcome.result !== "halted",
      result: outcome.result,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      trade: outcome.trade,
      mode: outcome.mode,
      blockers: outcome.blockers,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// Manual trade mutation only permits cancellation; verified scores grade settlement.
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: string; date?: string; password?: string; status?: Trade["status"] };
    if (!isAuthorized(request, body.password)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!body.id || !body.date) {
      return NextResponse.json({ error: "Missing id or date" }, { status: 400 });
    }
    if (body.status !== "cancelled") return NextResponse.json({ error: "Only cancellation is allowed; final settlement uses verified scores" }, { status: 400 });
    const { id, date } = body;
    const updates: Partial<Trade> = { status: "cancelled", closedAt: new Date().toISOString() };

    const ok = await updateTrade(id, date, updates);
    if (!ok) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
