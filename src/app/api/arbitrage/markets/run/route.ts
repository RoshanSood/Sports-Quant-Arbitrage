import { NextRequest, NextResponse } from "next/server";
import { isRunning } from "@/lib/arbitrage/marketStore";
import { runIngestion } from "@/lib/arbitrage/ingest";
import { isAuthorized } from "@/lib/adminAuth";
import { pacificTodayDateStr } from "@/lib/arbitrage/date";

// Triggers Phase 3 ingestion (Kalshi + Polymarket game totals → NormalizedMarket).
// Follows the value-plays/run pattern: auth, running guard, fire-and-forget; the
// client polls GET /api/arbitrage/markets for results.

export async function POST(request: NextRequest) {
  let body: { date?: string; password?: string } = {};
  try {
    body = await request.json();
  } catch {
    // body optional
  }

  if (!isAuthorized(request, body.password)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = body.date ?? pacificTodayDateStr();
  if (isRunning(date)) {
    return NextResponse.json({ status: "already-running", date });
  }

  // Fire and forget — runIngestion sets the running flag synchronously on entry
  // and clears it when done; the client polls GET /api/arbitrage/markets.
  runIngestion(date).catch((e) => console.error(`[arbitrage/markets/run] ${date} failed:`, e));

  return NextResponse.json({ status: "started", date });
}
