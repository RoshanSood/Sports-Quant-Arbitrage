import { NextRequest, NextResponse } from "next/server";
import { isRunning } from "@/lib/valuePlaysCache";
import { runValuePlaysForDate } from "@/lib/valuePlaysRunner";

const CRON_SECRET = process.env.CRON_SECRET;

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// Railway cron hits this endpoint at 0 8 * * * (8 AM UTC = midnight PST).
// Authorization: Bearer CRON_SECRET
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = todayDateStr();

  // Start both sources in background — Railway doesn't need to wait for completion
  const sources = (["polymarket", "kalshi"] as const).filter((s) => !isRunning(date, s));

  for (const source of sources) {
    runValuePlaysForDate(date, source).catch((e) =>
      console.error(`[cron/value-plays] ${source} ${date} error:`, e)
    );
  }

  return NextResponse.json({
    started: true,
    date,
    sources,
    message: sources.length === 0 ? "All sources already running" : `Started: ${sources.join(", ")}`,
  });
}
