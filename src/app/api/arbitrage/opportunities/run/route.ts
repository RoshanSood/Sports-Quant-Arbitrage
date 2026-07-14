import { NextRequest, NextResponse } from "next/server";
import { isRunning, saveOpportunities, setRunning } from "@/lib/arbitrage/opportunityStore";
import { isAuthorized } from "@/lib/adminAuth";

// Async-job stub following the value-plays/run pattern. Phase 3 replaces the body
// with real cross-venue ingestion + arb detection; here it just marks a scan slot.

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

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

  const date = body.date ?? todayDateStr();
  if (isRunning(date)) {
    return NextResponse.json({ status: "already-running", date });
  }

  // Fire-and-forget scan placeholder. Real detection lands in Phase 3.
  setRunning(date, true);
  (async () => {
    try {
      // Phase 3: ingest Kalshi + Polymarket totals, match, detect arbs, size, then:
      await saveOpportunities(date, []);
    } catch (e) {
      console.error(`[arbitrage/opportunities/run] ${date} failed:`, e);
    } finally {
      setRunning(date, false);
    }
  })();

  return NextResponse.json({ status: "started", date });
}
