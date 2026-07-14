import { NextRequest, NextResponse } from "next/server";
import { appendLog, getLogs } from "@/lib/arbitrage/arbLogStore";
import type { ArbLog } from "@/types/arbitrage";

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date") ?? undefined;
    const logs = await getLogs(date);
    return NextResponse.json({ logs });
  } catch (error) {
    return NextResponse.json({ logs: [], error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const log = (await request.json()) as ArbLog;
    if (!log.id || !log.date) {
      return NextResponse.json({ error: "Missing log id or date" }, { status: 400 });
    }
    await appendLog(log);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
