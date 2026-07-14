import { NextRequest, NextResponse } from "next/server";
import { todayDateStr } from "@/lib/props/config";
import { getHealth, getRows, isRunning } from "@/lib/props/store";

// Paginated/filterable materialized rows (manual §24). The client polls this while
// an ingestion is running to swap in live rows without a full re-bootstrap.
export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? todayDateStr();
    const rows = await getRows(date);
    const health = await getHealth();
    return NextResponse.json({ date, rows, health, running: isRunning(date) });
  } catch (error) {
    return NextResponse.json({ date: null, rows: [], health: [], running: false, error: String(error) }, { status: 500 });
  }
}
