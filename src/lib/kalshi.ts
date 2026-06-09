import { GameMarket, MLBGame, OddsOption } from "@/types";
import { teamMatchesTitle } from "./teamNormalization";
import { kalshiGet } from "./kalshiAuth";

const MLB_GAME_SERIES   = "KXMLBGAME";
const MLB_SPREAD_SERIES = "KXMLBSPREAD";
const MLB_TOTAL_SERIES  = "KXMLBTOTAL";

type KalshiMarket = {
  ticker: string;
  event_ticker: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: "unopened" | "open" | "active" | "closed" | "settled" | string;
  open_time?: string;
  close_time?: string;
  expected_expiration_time?: string;
  expiration_time?: string;
  yes_bid?: number;
  yes_ask?: number;
  last_price?: number;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  last_price_dollars?: string | number;
  volume?: number;
  open_interest?: number;
  result?: string;
};

type KalshiEvent = {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  markets?: KalshiMarket[];
};

type EventsResponse = {
  events: KalshiEvent[];
  cursor?: string;
};

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchEventsBySeries(seriesTicker: string): Promise<KalshiEvent[]> {
  const params = new URLSearchParams({
    series_ticker: seriesTicker,
    status: "open",
    with_nested_markets: "true",
    limit: "200",
  });
  try {
    const data = await kalshiGet<EventsResponse>(`/events?${params}`, {
      revalidate: 120,
    });
    return data.events ?? [];
  } catch (err) {
    console.error(`[Kalshi] events fetch failed (${seriesTicker}):`, err);
    return [];
  }
}

type Series = { ticker: string; category?: string; title?: string };
async function fetchSportSeries(query: string): Promise<Series[]> {
  try {
    const data = await kalshiGet<{ series?: Series[] }>(
      `/series?category=Sports&limit=200`,
      { revalidate: 3600 }
    );
    const ticker = query.toUpperCase();
    return (data.series ?? []).filter((s) => s.ticker?.includes(ticker));
  } catch {
    return [];
  }
}

// ── Price helpers ────────────────────────────────────────────────────────────

function readBidAsk(market: KalshiMarket): { bid: number | null; ask: number | null } {
  let bid: number | null = null;
  let ask: number | null = null;

  if (market.yes_bid_dollars != null) {
    const n = Number(market.yes_bid_dollars);
    if (Number.isFinite(n)) bid = n;
  } else if (market.yes_bid != null && Number.isFinite(market.yes_bid)) {
    bid = market.yes_bid / 100;
  }

  if (market.yes_ask_dollars != null) {
    const n = Number(market.yes_ask_dollars);
    if (Number.isFinite(n)) ask = n;
  } else if (market.yes_ask != null && Number.isFinite(market.yes_ask)) {
    ask = market.yes_ask / 100;
  }

  return { bid, ask };
}

function midPrice(market: KalshiMarket): number | null {
  const { bid, ask } = readBidAsk(market);
  if (bid != null && ask != null) return parseFloat(((bid + ask) / 2).toFixed(4));
  if (bid != null) return bid;
  if (ask != null) return ask;
  if (market.last_price_dollars != null) {
    const n = Number(market.last_price_dollars);
    if (Number.isFinite(n)) return n;
  }
  if (market.last_price != null && Number.isFinite(market.last_price)) {
    return market.last_price / 100;
  }
  return null;
}

function priceToDisplayCents(price: number | null): string {
  if (price == null) return "N/A";
  return `${Math.round(price * 100)}¢`;
}

function formatVolume(vol: number | null | undefined): string | null {
  if (vol == null || vol === 0) return null;
  if (vol >= 1000) return `$${(vol / 1000).toFixed(2)}K`;
  return `$${vol.toFixed(0)}`;
}

function isUsable(market: KalshiMarket): boolean {
  if (market.status === "settled" || market.status === "closed") return false;
  return midPrice(market) != null;
}

// ── Team matching ────────────────────────────────────────────────────────────

function eventSearchText(event: KalshiEvent): string {
  return [event.title, event.sub_title].filter(Boolean).join(" ");
}

function eventMatchesGame(game: MLBGame, event: KalshiEvent): boolean {
  const text = eventSearchText(event);
  if (!text) return false;
  const awayHit = teamMatchesTitle(
    game.awayTeam.name,
    game.awayTeam.shortName,
    game.awayTeam.abbreviation,
    text
  );
  const homeHit = teamMatchesTitle(
    game.homeTeam.name,
    game.homeTeam.shortName,
    game.homeTeam.abbreviation,
    text
  );
  return awayHit && homeHit;
}

function marketYesSide(market: KalshiMarket, game: MLBGame): "away" | "home" | null {
  const text = market.yes_sub_title ?? "";
  if (!text.trim()) return null;
  const awayHit = teamMatchesTitle(
    game.awayTeam.name,
    game.awayTeam.shortName,
    game.awayTeam.abbreviation,
    text
  );
  const homeHit = teamMatchesTitle(
    game.homeTeam.name,
    game.homeTeam.shortName,
    game.homeTeam.abbreviation,
    text
  );
  if (awayHit && !homeHit) return "away";
  if (homeHit && !awayHit) return "home";
  return null;
}

// ── Line extraction ──────────────────────────────────────────────────────────

// Extracts the magnitude of the spread line (always positive in Kalshi format).
// "Los Angeles D wins by over 1.5 runs" → 1.5
function extractSpreadLine(market: KalshiMarket): number | null {
  const text = `${market.title ?? ""} ${market.subtitle ?? ""} ${market.yes_sub_title ?? ""}`;
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Extracts the total line from "Over N.5 runs scored" format.
function extractTotalLine(market: KalshiMarket): number | null {
  const text = `${market.title ?? ""} ${market.subtitle ?? ""} ${market.yes_sub_title ?? ""}`;
  const m = text.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// ── Option builders ──────────────────────────────────────────────────────────

function buildMoneyline(markets: KalshiMarket[], game: MLBGame): OddsOption[] {
  type Candidate = { m: KalshiMarket; yesSide: "away" | "home"; bidAskSpread: number };
  const candidates: Candidate[] = [];

  for (const m of markets) {
    if (!isUsable(m)) continue;
    const yesSide = marketYesSide(m, game);
    if (!yesSide) continue;
    const { bid, ask } = readBidAsk(m);
    // Infinity for markets with no live quotes so they rank last
    const bidAskSpread = bid != null && ask != null ? ask - bid : Infinity;
    candidates.push({ m, yesSide, bidAskSpread });
  }

  if (!candidates.length) return [];

  // Most liquid (tightest bid/ask) = main game-winner market, avoids stale derivatives
  candidates.sort((a, b) => a.bidAskSpread - b.bidAskSpread);
  const best = candidates[0];

  const yesPrice = midPrice(best.m);
  if (yesPrice == null) return [];
  const noPrice = parseFloat((1 - yesPrice).toFixed(4));

  const yesOpt: OddsOption = {
    label: best.yesSide === "away" ? game.awayTeam.abbreviation : game.homeTeam.abbreviation,
    price: yesPrice,
    displayPrice: priceToDisplayCents(yesPrice),
  };
  const noOpt: OddsOption = {
    label: best.yesSide === "away" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation,
    price: noPrice,
    displayPrice: priceToDisplayCents(noPrice),
  };
  return best.yesSide === "away" ? [yesOpt, noOpt] : [noOpt, yesOpt];
}

// Kalshi spread format: "TEAM wins by over N.5 runs"
// YES = TEAM covers -N.5. When a hint is supplied (from Polymarket), filter to that
// exact line first, then pick the market for the specified team. Falls back to tightest
// bid/ask when no hint is given or no match is found.
function buildSpread(
  markets: KalshiMarket[],
  game: MLBGame,
  hint?: { abbr: string; line: number }
): OddsOption[] {
  type Candidate = { m: KalshiMarket; line: number; yesSide: "away" | "home"; mid: number; spread: number };
  const candidates: Candidate[] = [];

  for (const m of markets) {
    if (m.status === "settled" || m.status === "closed") continue;
    const { bid, ask } = readBidAsk(m);
    if (bid == null || ask == null || bid < 0.05) continue;
    const line = extractSpreadLine(m);
    const yesSide = marketYesSide(m, game);
    if (line == null || yesSide == null) continue;
    candidates.push({ m, line, yesSide, mid: (bid + ask) / 2, spread: ask - bid });
  }

  if (!candidates.length) return [];

  // MLB runline is always 1.5 — prefer that line regardless of what other lines Kalshi
  // offers (2.5, 3.5, etc.). Use Polymarket's line if provided, otherwise default to 1.5.
  const targetLine = hint?.line ?? 1.5;
  const linePool = candidates.filter((c) => Math.abs(c.line - targetLine) < 0.01);
  const pool = linePool.length > 0 ? linePool : candidates;

  pool.sort((a, b) => a.spread - b.spread);

  // Use Polymarket's team hint to determine which team gets the -line label
  let pick = pool[0];
  if (hint?.abbr) {
    const hinted = pool.find((c) => {
      const abbr = c.yesSide === "away" ? game.awayTeam.abbreviation : game.homeTeam.abbreviation;
      return abbr.toLowerCase() === hint.abbr.toLowerCase();
    });
    if (hinted) pick = hinted;
  }

  const yesPrice = midPrice(pick.m);
  if (yesPrice == null) return [];
  const noPrice = parseFloat((1 - yesPrice).toFixed(4));
  const lineMag = Math.abs(pick.line);
  const yesIsAway = pick.yesSide === "away";
  const awayLine = yesIsAway ? -lineMag : lineMag;
  const homeLine = -awayLine;
  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);

  return [
    {
      label: `${game.awayTeam.abbreviation} ${fmt(awayLine)}`,
      price: yesIsAway ? yesPrice : noPrice,
      displayPrice: priceToDisplayCents(yesIsAway ? yesPrice : noPrice),
    },
    {
      label: `${game.homeTeam.abbreviation} ${fmt(homeLine)}`,
      price: yesIsAway ? noPrice : yesPrice,
      displayPrice: priceToDisplayCents(yesIsAway ? noPrice : yesPrice),
    },
  ];
}

// Kalshi total format: "Over N.5 runs scored" where YES = over, NO = under.
// Pick the market with the tightest bid/ask spread (most liquid), breaking ties
// by choosing the line closest to 50¢ (the consensus main total).
function buildTotal(markets: KalshiMarket[]): OddsOption[] {
  type Candidate = { m: KalshiMarket; line: number; mid: number; spread: number };
  const candidates: Candidate[] = [];

  for (const m of markets) {
    if (m.status === "settled" || m.status === "closed") continue;
    const { bid, ask } = readBidAsk(m);
    if (bid == null || ask == null || bid < 0.05) continue;
    const line = extractTotalLine(m);
    if (line == null) continue;
    candidates.push({ m, line, mid: (bid + ask) / 2, spread: ask - bid });
  }

  if (!candidates.length) return [];

  // Tightest spread primary, closest to 50¢ secondary
  candidates.sort((a, b) => {
    const diff = a.spread - b.spread;
    if (Math.abs(diff) > 0.005) return diff;
    return Math.abs(a.mid - 0.5) - Math.abs(b.mid - 0.5);
  });

  const best = candidates[0];
  const overPrice = parseFloat(best.mid.toFixed(4));
  const underPrice = parseFloat((1 - overPrice).toFixed(4));

  return [
    { label: `O ${best.line}`, price: overPrice, displayPrice: priceToDisplayCents(overPrice) },
    { label: `U ${best.line}`, price: underPrice, displayPrice: priceToDisplayCents(underPrice) },
  ];
}

// ── Top-level: fetch + merge into GameMarket ─────────────────────────────────

export async function fetchKalshiData(
  games: MLBGame[],
  spreadHints?: Map<string, { abbr: string; line: number }> // gameId → Polymarket spread hint
): Promise<Map<string, GameMarket>> {
  if (!games.length) return new Map();

  const [gameEvents, spreadEvents, totalEvents] = await Promise.all([
    fetchEventsBySeries(MLB_GAME_SERIES),
    fetchEventsBySeries(MLB_SPREAD_SERIES),
    fetchEventsBySeries(MLB_TOTAL_SERIES),
  ]);

  const marketMap = new Map<string, GameMarket>();

  for (const game of games) {
    const mlEvents  = gameEvents.filter((ev) => eventMatchesGame(game, ev));
    const spEvents  = spreadEvents.filter((ev) => eventMatchesGame(game, ev));
    const totEvents = totalEvents.filter((ev) => eventMatchesGame(game, ev));

    if (!mlEvents.length && !spEvents.length && !totEvents.length) continue;

    const moneylineMarkets = mlEvents.flatMap((ev) => ev.markets ?? []);
    const spreadMarkets    = spEvents.flatMap((ev) => ev.markets ?? []);
    const totalMarkets     = totEvents.flatMap((ev) => ev.markets ?? []);
    const volumeSum = [...moneylineMarkets, ...spreadMarkets, ...totalMarkets]
      .reduce((s, m) => s + (typeof m.volume === "number" ? m.volume : 0), 0);

    const gameMarket: GameMarket = {
      moneyline: buildMoneyline(moneylineMarkets, game),
      spread: buildSpread(spreadMarkets, game, spreadHints?.get(game.id)),
      total: buildTotal(totalMarkets),
      volume: formatVolume(volumeSum),
    };

    if (gameMarket.moneyline.length > 0) {
      marketMap.set(game.id, gameMarket);
    }
  }

  return marketMap;
}

export { fetchSportSeries };
