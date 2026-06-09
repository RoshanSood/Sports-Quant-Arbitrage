import { NextRequest, NextResponse } from "next/server";
import { placeKalshiOrder, TradeTarget } from "@/lib/kalshiTrade";
import { saveLiveTrade, LiveTrade } from "@/lib/liveTradeStore";
import { isKalshiConfigured, extractCredsFromHeaders } from "@/lib/kalshiAuth";

type TradeRequest = {
  recId: string;
  game: string;
  pick: string;
  marketType: string;
  ticker: string;
  side: "yes" | "no";
  contracts: number;
  limitPriceCents: number;
  estimatedCost: number;
};

export async function POST(request: NextRequest) {
  const creds = extractCredsFromHeaders(request.headers);

  if (!isKalshiConfigured() && !creds) {
    return NextResponse.json(
      { error: "Kalshi API keys not configured" },
      { status: 503 }
    );
  }

  let body: { trades: TradeRequest[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { trades } = body;
  if (!Array.isArray(trades) || trades.length === 0) {
    return NextResponse.json({ error: "No trades provided" }, { status: 400 });
  }

  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  const results = [];

  for (const trade of trades) {
    const target: TradeTarget = {
      ticker: trade.ticker,
      side: trade.side,
      askCents: trade.limitPriceCents,
      contracts: trade.contracts,
      estimatedCost: trade.estimatedCost,
    };

    const tradeId = `${dateStr}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    try {
      const placed = await placeKalshiOrder(target, creds);

      const liveTrade: LiveTrade = {
        id: tradeId,
        orderId: placed.orderId,
        recId: trade.recId,
        date: dateStr,
        ticker: placed.ticker,
        side: placed.side,
        contracts: placed.contracts,
        limitPriceCents: placed.limitPriceCents,
        estimatedCost: trade.estimatedCost,
        game: trade.game,
        pick: trade.pick,
        marketType: trade.marketType,
        placedAt: new Date().toISOString(),
        status: placed.status === "executed" ? "filled" : "open",
      };

      await saveLiveTrade(liveTrade);
      results.push({ recId: trade.recId, success: true, orderId: placed.orderId, status: placed.status });
    } catch (err) {
      console.error("[live-trading/execute]", err);
      const errorMsg = err instanceof Error ? err.message : "Order failed";

      const liveTrade: LiveTrade = {
        id: tradeId,
        orderId: null,
        recId: trade.recId,
        date: dateStr,
        ticker: trade.ticker,
        side: trade.side,
        contracts: trade.contracts,
        limitPriceCents: trade.limitPriceCents,
        estimatedCost: trade.estimatedCost,
        game: trade.game,
        pick: trade.pick,
        marketType: trade.marketType,
        placedAt: new Date().toISOString(),
        status: "error",
        errorMessage: errorMsg,
      };

      await saveLiveTrade(liveTrade);
      results.push({ recId: trade.recId, success: false, error: errorMsg });
    }
  }

  return NextResponse.json({ results });
}
