import { NextRequest, NextResponse } from "next/server";
import { fetchESPNGames } from "@/lib/espn";
import { fetchPolymarketData } from "@/lib/polymarket";
import { fetchKalshiMoneylines } from "@/lib/kalshiMarkets";
import { KalshiPrice } from "@/lib/kalshiMarkets";
import { OddsOption } from "@/types";

export type MarketPrice = {
  probability: number;   // 0–1
  askCents?: number;     // Kalshi only
};

export type GameMarketRow = {
  gameId: string;
  date: string;          // YYYY-MM-DD
  startTime: string;
  status: string;
  awayTeam: {
    name: string;
    shortName: string;
    abbreviation: string;
    logo: string;
    record: string;
  };
  homeTeam: {
    name: string;
    shortName: string;
    abbreviation: string;
    logo: string;
    record: string;
  };
  kalshi: {
    away: MarketPrice | null;
    home: MarketPrice | null;
  };
  polymarket: {
    away: MarketPrice | null;
    home: MarketPrice | null;
    volume: string | null;
  };
};

export type MarketsResponse = {
  date: string;
  rows: GameMarketRow[];
  error?: string;
};

function kalshiToMarketPrice(p: KalshiPrice | null): MarketPrice | null {
  if (!p) return null;
  return { probability: p.probability, askCents: p.askCents };
}

function oddsOptionToMarketPrice(o: OddsOption | null | undefined): MarketPrice | null {
  if (!o || o.price == null) return null;
  return { probability: o.price };
}

function todayDateStr(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET(request: NextRequest) {
  const dateParam = request.nextUrl.searchParams.get("date") ?? todayDateStr();

  // Accept YYYYMMDD
  const yyyymmdd = dateParam.replace(/-/g, "").slice(0, 8);
  if (!/^\d{8}$/.test(yyyymmdd)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYYMMDD." }, { status: 400 });
  }

  const isoDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

  try {
    const games = await fetchESPNGames(yyyymmdd);

    // Fetch Polymarket and Kalshi in parallel; degrade gracefully on failure
    const [polyResult, kalshiResult] = await Promise.allSettled([
      fetchPolymarketData(games),
      fetchKalshiMoneylines(games),
    ]);

    const polyMap = polyResult.status === "fulfilled" ? polyResult.value : new Map();
    const kalshiMap = kalshiResult.status === "fulfilled" ? kalshiResult.value : new Map();

    const rows: GameMarketRow[] = games.map((game) => {
      const poly = polyMap.get(game.id);
      const kalshi = kalshiMap.get(game.id) ?? { home: null, away: null };

      // Polymarket moneyline: [away, home] order
      const polyAway = oddsOptionToMarketPrice(poly?.moneyline?.[0]);
      const polyHome = oddsOptionToMarketPrice(poly?.moneyline?.[1]);

      return {
        gameId: game.id,
        date: game.date,
        startTime: game.startTime,
        status: game.status,
        awayTeam: {
          name: game.awayTeam.name,
          shortName: game.awayTeam.shortName,
          abbreviation: game.awayTeam.abbreviation,
          logo: game.awayTeam.logo,
          record: game.awayTeam.record,
        },
        homeTeam: {
          name: game.homeTeam.name,
          shortName: game.homeTeam.shortName,
          abbreviation: game.homeTeam.abbreviation,
          logo: game.homeTeam.logo,
          record: game.homeTeam.record,
        },
        kalshi: {
          away: kalshiToMarketPrice(kalshi.away),
          home: kalshiToMarketPrice(kalshi.home),
        },
        polymarket: {
          away: polyAway,
          home: polyHome,
          volume: poly?.volume ?? null,
        },
      };
    });

    return NextResponse.json({ date: isoDate, rows } satisfies MarketsResponse);
  } catch (err) {
    console.error("[markets]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load markets", date: isoDate, rows: [] },
      { status: 500 }
    );
  }
}
