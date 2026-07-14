import { NextRequest, NextResponse } from "next/server";
import { isRunning } from "@/lib/valuePlaysCache";
import { runValuePlaysForDate } from "@/lib/valuePlaysRunner";
import { isAuthorized } from "@/lib/adminAuth";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function POST(request: NextRequest) {
  let body: { date?: string; source?: string; password?: string } = {};
  try {
    body = await request.json();
  } catch {
    // ignore parse errors — body is optional
  }

  if (!isAuthorized(request, body.password)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = body.date ?? todayDateStr();
  const source = (body.source === "kalshi" ? "kalshi" : "polymarket") as "polymarket" | "kalshi";

  if (isRunning(date, source)) {
    return NextResponse.json({ status: "already-running" });
  }

  // Fire and forget — client polls /api/value-plays/cached for results
  runValuePlaysForDate(date, source).catch((e) =>
    console.error(`[value-plays/run] ${source} ${date} failed:`, e)
  );

  return NextResponse.json({ status: "started", date, source });
}
