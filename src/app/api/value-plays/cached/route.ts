import { NextRequest, NextResponse } from "next/server";
import { getCached, isRunning } from "@/lib/valuePlaysCache";

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date") ?? todayDateStr();
  const source = request.nextUrl.searchParams.get("source") ?? "polymarket";

  const entry = await getCached(date, source);
  const running = isRunning(date, source);

  return NextResponse.json({ entry: entry ?? null, running });
}
