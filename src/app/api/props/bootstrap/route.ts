import { NextRequest, NextResponse } from "next/server";
import { BOOKS } from "@/lib/props/books";
import { DEFAULT_FILTERS, todayDateStr } from "@/lib/props/config";
import { runProps } from "@/lib/props/ingest";
import { getHealth, getRows, isRunning } from "@/lib/props/store";

// First-render payload (manual §24): rows, visible books, filters, provider health.
// If there are no materialized rows yet and the provider key is configured, kicks
// off an ingestion server-side (no trigger password reaches the browser) and returns
// running:true so the client polls GET /api/props/rows.
export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? todayDateStr();
    const providerConfigured = Boolean(process.env.SPORTSGAMEODDS_KEY);
    const rows = await getRows(date);
    const health = await getHealth();

    let running = isRunning(date);
    if (rows.length === 0 && !running && providerConfigured) {
      runProps(date).catch((e) => console.error(`[props/bootstrap] ${date} failed:`, e));
      running = true;
    }

    return NextResponse.json({
      date,
      rows,
      books: BOOKS,
      health,
      filters: DEFAULT_FILTERS,
      running,
      providerConfigured,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { date: null, rows: [], books: BOOKS, health: [], filters: DEFAULT_FILTERS, running: false, providerConfigured: false, error: String(error) },
      { status: 500 }
    );
  }
}
