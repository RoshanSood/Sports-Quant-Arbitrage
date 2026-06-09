import { NextRequest, NextResponse } from "next/server";
import { getLiveTrades } from "@/lib/liveTradeStore";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") ?? undefined;

  try {
    const trades = await getLiveTrades(date);
    return NextResponse.json({ trades });
  } catch (err) {
    console.error("[live-trading/history]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load history" },
      { status: 500 }
    );
  }
}
