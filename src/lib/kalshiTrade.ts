import { kalshiGet, kalshiPost, KalshiCreds } from "./kalshiAuth";
import { teamMatchesTitle } from "./teamNormalization";
import { TrackedRecommendation } from "@/types/performance";

const GAME_SERIES   = "KXMLBGAME";
const SPREAD_SERIES = "KXMLBSPREAD";
const TOTAL_SERIES  = "KXMLBTOTAL";

type KM = {
  ticker: string;
  yes_sub_title?: string;
  status?: string;
  yes_bid?: number;
  yes_ask?: number;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
};

type KE = {
  event_ticker: string;
  title?: string;
  sub_title?: string;
  markets?: KM[];
};

type KalshiOrderResponse = {
  order_id: string;
  fill_count: string;
  remaining_count: string;
  ts_ms: number;
  client_order_id?: string;
  average_fill_price?: string;
  average_fee_paid?: string;
};

export type TradeTarget = {
  ticker: string;
  side: "yes" | "no";
  askCents: number;
  contracts: number;
  estimatedCost: number;
};

export type PlacedOrder = {
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  contracts: number;
  limitPriceCents: number;
  status: string;
};

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchSeriesEvents(series: string, creds?: KalshiCreds): Promise<KE[]> {
  const params = new URLSearchParams({
    series_ticker: series,
    status: "open",
    with_nested_markets: "true",
    limit: "200",
  });
  try {
    const data = await kalshiGet<{ events?: KE[] }>(`/events?${params}`, {}, creds);
    return data.events ?? [];
  } catch {
    return [];
  }
}

// ── Price helpers ────────────────────────────────────────────────────────────

function getAskCents(m: KM): number | null {
  if (m.yes_ask_dollars != null) {
    const n = Number(m.yes_ask_dollars);
    if (Number.isFinite(n) && n >= 0.01 && n <= 0.99) return Math.round(n * 100);
  }
  if (m.yes_ask != null && Number.isFinite(m.yes_ask) && m.yes_ask >= 1 && m.yes_ask <= 99) {
    return Math.round(m.yes_ask);
  }
  return null;
}

function getBidCents(m: KM): number | null {
  if (m.yes_bid_dollars != null) {
    const n = Number(m.yes_bid_dollars);
    if (Number.isFinite(n) && n >= 0.01 && n <= 0.99) return Math.round(n * 100);
  }
  if (m.yes_bid != null && Number.isFinite(m.yes_bid) && m.yes_bid >= 1 && m.yes_bid <= 99) {
    return Math.round(m.yes_bid);
  }
  return null;
}

function isUsable(m: KM): boolean {
  return m.status !== "settled" && m.status !== "closed";
}

// ── Team matching ────────────────────────────────────────────────────────────

function matchesTeam(
  team: { name: string; abbreviation: string },
  text: string
): boolean {
  return teamMatchesTitle(team.name, team.name, team.abbreviation, text);
}

function eventMatchesTeams(
  away: { name: string; abbreviation: string },
  home: { name: string; abbreviation: string },
  ev: KE
): boolean {
  const text = [ev.title, ev.sub_title].filter(Boolean).join(" ");
  if (!text) return false;
  return matchesTeam(away, text) && matchesTeam(home, text);
}

function yesSideTeam(
  m: KM,
  away: { name: string; abbreviation: string },
  home: { name: string; abbreviation: string }
): "away" | "home" | null {
  const text = m.yes_sub_title ?? "";
  if (!text.trim()) return null;
  const a = matchesTeam(away, text);
  const h = matchesTeam(home, text);
  if (a && !h) return "away";
  if (h && !a) return "home";
  return null;
}

function extractLine(m: KM): number | null {
  const text = m.yes_sub_title ?? "";
  const match = text.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// ── Build helpers ────────────────────────────────────────────────────────────

function buildTarget(
  ticker: string,
  side: "yes" | "no",
  priceCents: number,
  betAmount: number
): TradeTarget | null {
  const contracts = Math.floor((betAmount * 100) / priceCents);
  if (contracts === 0) return null;
  return {
    ticker,
    side,
    askCents: priceCents,
    contracts,
    estimatedCost: parseFloat(((contracts * priceCents) / 100).toFixed(2)),
  };
}

function bestBySpread(markets: KM[]): KM | null {
  const usable = markets.filter(
    (m) => isUsable(m) && getBidCents(m) != null && getAskCents(m) != null
  );
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const sa = (getAskCents(a) ?? 99) - (getBidCents(a) ?? 1);
    const sb = (getAskCents(b) ?? 99) - (getBidCents(b) ?? 1);
    return sa - sb;
  });
  return usable[0];
}

// ── Public: resolve a stored recommendation to a live Kalshi ticker ──────────

export async function resolveTradeTarget(
  rec: TrackedRecommendation,
  betAmount = 10,
  creds?: KalshiCreds
): Promise<TradeTarget | null> {
  if (rec.league !== "MLB") return null;

  const away = rec.awayTeam;
  const home = rec.homeTeam;
  const { marketType, pickSide, recommendedPick } = rec;

  const series =
    marketType === "moneyline" ? GAME_SERIES
    : marketType === "spread"  ? SPREAD_SERIES
    : TOTAL_SERIES;

  const events = await fetchSeriesEvents(series, creds);
  const gameEvents = events.filter((ev) => eventMatchesTeams(away, home, ev));
  if (!gameEvents.length) return null;

  const allMarkets = gameEvents
    .flatMap((ev) => ev.markets ?? [])
    .filter(isUsable);
  if (!allMarkets.length) return null;

  // ── Total ────────────────────────────────────────────────────────────────
  if (marketType === "total") {
    const lineMatch = recommendedPick.match(/(\d+(?:\.\d+)?)/);
    const targetLine = lineMatch ? parseFloat(lineMatch[1]) : null;
    const isOver = pickSide === "over";

    const lineMarkets = targetLine != null
      ? allMarkets.filter((m) => {
          const l = extractLine(m);
          return l != null && Math.abs(l - targetLine) < 0.01;
        })
      : allMarkets;

    const best = bestBySpread(lineMarkets);
    if (!best) return null;

    if (isOver) {
      const ac = getAskCents(best);
      if (!ac) return null;
      return buildTarget(best.ticker, "yes", ac, betAmount);
    } else {
      const bc = getBidCents(best);
      if (!bc) return null;
      const noAsk = 100 - bc;
      if (noAsk <= 1 || noAsk >= 99) return null;
      return buildTarget(best.ticker, "no", noAsk, betAmount);
    }
  }

  // ── Spread ───────────────────────────────────────────────────────────────
  if (marketType === "spread") {
    const lineMatch = recommendedPick.match(/[+-](\d+(?:\.\d+)?)/);
    const targetLine = lineMatch ? parseFloat(lineMatch[1]) : 1.5;
    const isFavorite = recommendedPick.includes("-");
    const pickedSide = pickSide === "away" ? "away" : "home";

    const lineMarkets = allMarkets.filter((m) => {
      const l = extractLine(m);
      return l != null && Math.abs(l - targetLine) < 0.01;
    });
    const pool = lineMarkets.length > 0 ? lineMarkets : allMarkets;

    if (isFavorite) {
      // Favorite covers: find market where picked team is YES, buy YES
      const m = pool.find((m) => yesSideTeam(m, away, home) === pickedSide);
      if (!m) return null;
      const ac = getAskCents(m);
      if (!ac) return null;
      return buildTarget(m.ticker, "yes", ac, betAmount);
    } else {
      // Underdog: find market where underdog team is YES
      const mYes = pool.find((m) => yesSideTeam(m, away, home) === pickedSide);
      if (mYes) {
        const ac = getAskCents(mYes);
        if (ac) return buildTarget(mYes.ticker, "yes", ac, betAmount);
      }
      // Fallback: buy NO on opponent's market
      const oppSide = pickedSide === "away" ? "home" : "away";
      const mOpp = pool.find((m) => yesSideTeam(m, away, home) === oppSide);
      if (!mOpp) return null;
      const bc = getBidCents(mOpp);
      if (!bc) return null;
      const noAsk = 100 - bc;
      if (noAsk <= 1 || noAsk >= 99) return null;
      return buildTarget(mOpp.ticker, "no", noAsk, betAmount);
    }
  }

  // ── Moneyline ────────────────────────────────────────────────────────────
  const pickedSide = pickSide === "away" ? "away" : "home";

  // Find market where picked team is YES
  const mYes = allMarkets
    .filter((m) => {
      const bc = getBidCents(m);
      const ac = getAskCents(m);
      return bc != null && ac != null && yesSideTeam(m, away, home) === pickedSide;
    })
    .sort((a, b) => {
      const sa = (getAskCents(a) ?? 99) - (getBidCents(a) ?? 1);
      const sb = (getAskCents(b) ?? 99) - (getBidCents(b) ?? 1);
      return sa - sb;
    })[0];

  if (mYes) {
    const ac = getAskCents(mYes);
    if (!ac) return null;
    return buildTarget(mYes.ticker, "yes", ac, betAmount);
  }

  // Fallback: buy NO on opponent's market
  const oppSide = pickedSide === "away" ? "home" : "away";
  const mOpp = allMarkets
    .filter((m) => getBidCents(m) != null && yesSideTeam(m, away, home) === oppSide)
    .sort((a, b) => {
      const sa = (getAskCents(a) ?? 99) - (getBidCents(a) ?? 1);
      const sb = (getAskCents(b) ?? 99) - (getBidCents(b) ?? 1);
      return sa - sb;
    })[0];

  if (!mOpp) return null;
  const bc = getBidCents(mOpp);
  if (!bc) return null;
  const noAsk = 100 - bc;
  if (noAsk <= 1 || noAsk >= 99) return null;
  return buildTarget(mOpp.ticker, "no", noAsk, betAmount);
}

// ── Public: place a limit buy order on Kalshi ────────────────────────────────

export async function placeKalshiOrder(target: TradeTarget, creds?: KalshiCreds): Promise<PlacedOrder> {
  const isYes = target.side === "yes";

  // New v2 event-order endpoint uses bid/ask single-book shape with dollar prices.
  // "bid" = buy YES; "ask" = sell YES (equivalent to buying NO).
  // For NO side: we sell YES at (100 - noAskCents)/100 dollars, which costs noAskCents/100 net.
  const price = isYes
    ? (target.askCents / 100).toFixed(6)
    : ((100 - target.askCents) / 100).toFixed(6);

  const body: Record<string, unknown> = {
    ticker: target.ticker,
    side: isYes ? "bid" : "ask",
    count: target.contracts.toFixed(2),
    price,
    time_in_force: "good_till_canceled",
    self_trade_prevention_type: "taker_at_cross",
  };

  const data = await kalshiPost<KalshiOrderResponse>("/portfolio/events/orders", body, creds);

  const fillCount = parseFloat(data.fill_count ?? "0");
  const remainingCount = parseFloat(data.remaining_count ?? "0");
  const status = fillCount > 0 && remainingCount === 0 ? "executed" : "resting";

  return {
    orderId: data.order_id,
    ticker: target.ticker,
    side: target.side,
    contracts: target.contracts,
    limitPriceCents: target.askCents,
    status,
  };
}
