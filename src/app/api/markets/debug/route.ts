import { NextRequest, NextResponse } from "next/server";
import { kalshiGet } from "@/lib/kalshiAuth";
import { fetchESPNGames } from "@/lib/espn";
import { teamMatchesTitle } from "@/lib/teamNormalization";

// Mirrors the KM/KE types in kalshiMarkets.ts but requests every field
type KMRaw = {
  ticker: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  no_bid_dollars?: string | number;
  no_ask_dollars?: string | number;
  close_time?: string;
  open_time?: string;
  expiration_time?: string;
  subtitle?: string;
  title?: string;
};

type KERaw = {
  event_ticker: string;
  title?: string;
  sub_title?: string;
  markets?: KMRaw[];
  open_time?: string;
  close_time?: string;
};

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  const dateParam = request.nextUrl.searchParams.get("date") ?? todayStr();
  const yyyymmdd = dateParam.replace(/-/g, "").slice(0, 8);

  // 1. Fetch raw Kalshi events
  const params = new URLSearchParams({
    series_ticker: "KXMLBGAME",
    status: "open",
    with_nested_markets: "true",
    limit: "200",
  });

  let rawEvents: KERaw[] = [];
  let kalshiFetchError: string | null = null;
  try {
    const data = await kalshiGet<{ events?: KERaw[] }>(`/events?${params}`);
    rawEvents = data.events ?? [];
  } catch (e) {
    kalshiFetchError = e instanceof Error ? e.message : String(e);
  }

  // 2. Fetch ESPN games for the date
  let espnGames: Awaited<ReturnType<typeof fetchESPNGames>> = [];
  let espnError: string | null = null;
  try {
    espnGames = await fetchESPNGames(yyyymmdd);
  } catch (e) {
    espnError = e instanceof Error ? e.message : String(e);
  }

  // 3. For each ESPN game, show what Kalshi events matched and how markets resolved
  const matchReport = espnGames.map((game) => {
    const away = game.awayTeam;
    const home = game.homeTeam;

    const matchedEvents = rawEvents.filter((ev) => {
      const text = [ev.title, ev.sub_title].filter(Boolean).join(" ");
      const awayMatch = teamMatchesTitle(away.name, away.shortName, away.abbreviation, text);
      const homeMatch = teamMatchesTitle(home.name, home.shortName, home.abbreviation, text);
      return awayMatch && homeMatch;
    });

    // Exclude run-line / spread markets — their yes_sub_title contains "+/-N.N"
    const allMarkets = matchedEvents.flatMap((ev) => ev.markets ?? []).filter(
      (m) => m.status !== "settled" && m.status !== "closed" && !/[+\-]\d/.test(m.yes_sub_title ?? "")
    );

    // Date filter
    const gameDate = game.date;
    const nextDate = (() => {
      const d = new Date(gameDate + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const sameDayMarkets = allMarkets.filter((m) => {
      if (!m.close_time) return true;
      const mDate = m.close_time.slice(0, 10);
      return mDate === gameDate || mDate === nextDate;
    });
    const marketsToUse = sameDayMarkets.length > 0 ? sameDayMarkets : allMarkets;

    const marketDetails = marketsToUse.map((m) => {
      const subTitle = m.yes_sub_title ?? "";
      const awayMatch = teamMatchesTitle(away.name, away.shortName, away.abbreviation, subTitle);
      const homeMatch = teamMatchesTitle(home.name, home.shortName, home.abbreviation, subTitle);
      let yesSide: "away" | "home" | "ambiguous" | "unmatched" = "unmatched";
      if (awayMatch && !homeMatch) yesSide = "away";
      else if (homeMatch && !awayMatch) yesSide = "home";
      else if (awayMatch && homeMatch) yesSide = "ambiguous";

      return {
        ticker: m.ticker,
        yes_sub_title: m.yes_sub_title,
        no_sub_title: m.no_sub_title,
        status: m.status,
        close_time: m.close_time,
        yes_ask: m.yes_ask,
        yes_bid: m.yes_bid,
        yes_ask_dollars: m.yes_ask_dollars,
        yes_bid_dollars: m.yes_bid_dollars,
        yesSideResolved: yesSide,
      };
    });

    return {
      espnGame: {
        id: game.id,
        date: game.date,
        startTime: game.startTime,
        status: game.status,
        away: `${away.abbreviation} (${away.name})`,
        home: `${home.abbreviation} (${home.name})`,
      },
      kalshiEventsMatched: matchedEvents.map((ev) => ({
        event_ticker: ev.event_ticker,
        title: ev.title,
        sub_title: ev.sub_title,
        close_time: ev.close_time,
        marketCount: (ev.markets ?? []).length,
      })),
      dateFilterSummary: {
        gameDate,
        allowedDates: [gameDate, nextDate],
        marketsBeforeFilter: allMarkets.length,
        marketsAfterFilter: marketsToUse.length,
      },
      markets: marketDetails,
    };
  });

  // 4. Return all raw events too, for full inspection
  const rawEventSummary = rawEvents.map((ev) => ({
    event_ticker: ev.event_ticker,
    title: ev.title,
    sub_title: ev.sub_title,
    close_time: ev.close_time,
    marketCount: (ev.markets ?? []).length,
    marketSample: (ev.markets ?? []).slice(0, 3).map((m) => ({
      ticker: m.ticker,
      yes_sub_title: m.yes_sub_title,
      status: m.status,
      close_time: m.close_time,
      yes_ask: m.yes_ask,
      yes_bid: m.yes_bid,
      yes_ask_dollars: m.yes_ask_dollars,
      yes_bid_dollars: m.yes_bid_dollars,
    })),
  }));

  return NextResponse.json({
    date: yyyymmdd,
    kalshiFetchError,
    espnError,
    totalKalshiEvents: rawEvents.length,
    totalESPNGames: espnGames.length,
    matchReport,
    rawKalshiEvents: rawEventSummary,
  });
}
