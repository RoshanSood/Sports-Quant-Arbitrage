import { NextRequest, NextResponse } from "next/server";
import { getPendingKalshiRecommendations } from "@/lib/kalshiRecommendationStore";
import { resolveTradeTarget } from "@/lib/kalshiTrade";
import { getTodayTrades } from "@/lib/liveTradeStore";
import { isKalshiConfigured, extractCredsFromHeaders } from "@/lib/kalshiAuth";

const UNIT_SIZE = 10; // $10 per unit — 7-8 confidence = 1 unit = $10

function betAmount(confidence: number): number {
  if (confidence >= 9) return UNIT_SIZE * 1.5;    // $15
  if (confidence >= 7) return UNIT_SIZE * 1;      // $10
  if (confidence >= 5) return UNIT_SIZE * 0.75;   // $7.50
  return UNIT_SIZE * 0.5;                          // $5
}

export async function GET(request: NextRequest) {
  const creds = extractCredsFromHeaders(request.headers);

  if (!isKalshiConfigured() && !creds) {
    return NextResponse.json(
      { error: "Kalshi API keys not configured" },
      { status: 503 }
    );
  }

  try {
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

    // Get today's pending Kalshi MLB recs, sorted by confidence then valueScore
    const allPending = await getPendingKalshiRecommendations();
    const todayMLB = allPending
      .filter((r) => r.date === dateStr && r.league === "MLB")
      .sort((a, b) => {
        const confDiff = b.confidence - a.confidence;
        if (confDiff !== 0) return confDiff;
        return (b.valueScore ?? 0) - (a.valueScore ?? 0);
      });

    // Check which recs already have a live trade today
    const todayTrades = await getTodayTrades(dateStr);
    const tradedRecIds = new Set(todayTrades.map((t) => t.recId));

    // Resolve tickers for all today's pending MLB recs
    const resolved = [];
    for (const rec of todayMLB) {
      const alreadyTraded = tradedRecIds.has(rec.id);
      if (alreadyTraded) {
        resolved.push({ rec, target: null, alreadyTraded: true });
        continue;
      }
      try {
        const target = await resolveTradeTarget(rec, betAmount(rec.confidence), creds);
        resolved.push({ rec, target, alreadyTraded: false });
      } catch (e) {
        resolved.push({
          rec,
          target: null,
          alreadyTraded: false,
          error: e instanceof Error ? e.message : "Resolve failed",
        });
      }
    }

    // Sort: tradeable proposals first, then already-traded, then unresolved
    const withTarget = resolved.filter((p) => p.target && !p.alreadyTraded);
    const alreadyTraded = resolved.filter((p) => p.alreadyTraded);
    const unresolved = resolved.filter((p) => !p.target && !p.alreadyTraded);
    const proposals = [...withTarget, ...alreadyTraded, ...unresolved];

    return NextResponse.json({ proposals, date: dateStr });
  } catch (err) {
    console.error("[live-trading/proposals]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load proposals" },
      { status: 500 }
    );
  }
}
