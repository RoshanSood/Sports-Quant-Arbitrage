import { GameMarket, MLBGame, OddsOption } from "@/types";
import { teamMatchesTitle } from "./teamNormalization";
import { kalshiGet } from "./kalshiAuth";
import type { ArbGame } from "./arbitrage/sports";

const MLB_GAME_SERIES   = "KXMLBGAME";
const MLB_SPREAD_SERIES = "KXMLBSPREAD";
const MLB_TOTAL_SERIES  = "KXMLBTOTAL";
// First-5-innings (F5): a parallel series ladder — same shape as full game, but a tie after
// 5 is possible (unlike a full 9-inning game), so the winner market is a per-team ladder
// (see fetchKalshiF5MoneylineByGame) rather than a single complementary yes/no ticker.
export const MLB_F5_GAME_SERIES = "KXMLBF5";
export const MLB_F5_TOTAL_SERIES = "KXMLBF5TOTAL";
export const MLB_F5_SPREAD_SERIES = "KXMLBF5SPREAD";

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
  yes_ask_size_fp?: number; // contracts resting at the yes ask (top of book)
  yes_bid_size_fp?: number; // contracts resting at the yes bid
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

function kalshiTickerIsoDate(ticker: string | undefined): string | null {
  const m = ticker?.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const [, yy, mon, dd] = m;
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(mon);
  if (month < 0) return null;
  return `20${yy}-${String(month + 1).padStart(2, "0")}-${dd}`;
}

function eventMatchesSlateDate(game: ArbGame, event: KalshiEvent): boolean {
  const tickers = [event.event_ticker, ...(event.markets ?? []).map((m) => m.ticker)];
  const dates = tickers.map(kalshiTickerIsoDate).filter((d): d is string => Boolean(d));
  return dates.length === 0 || dates.some((d) => d === game.date);
}

function eventMatchesGame(game: ArbGame, event: KalshiEvent): boolean {
  const text = eventSearchText(event);
  if (!text) return false;
  if (!eventMatchesSlateDate(game, event)) return false;
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

// ── Tennis event matching ────────────────────────────────────────────────────
// Kalshi's tennis event title/sub_title carry only LAST NAMES ("Samsonova vs Rybakina"),
// unlike team-sport events which carry full team names/cities that teamMatchesTitle's
// full-name/short-name/alias checks are built around — those checks never fire on
// last-name-only text (ESPN's full name "Liudmila Samsonova" and shortName "L. Samsonova"
// are both absent from "Samsonova vs Rybakina"). Verified live 2026-08-09 against
// KXWTAMATCH-26AUG09SAMRYB. Each MARKET's own yes_sub_title/no_sub_title, by contrast, DO
// carry the full player name, so marketYesSide (below) still uses the standard check.
export function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName;
}

export function eventMatchesTennisGame(game: ArbGame, event: KalshiEvent): boolean {
  const text = eventSearchText(event).toLowerCase();
  if (!text) return false;
  if (!eventMatchesSlateDate(game, event)) return false;
  const awayLast = lastNameOf(game.awayTeam.name).toLowerCase();
  const homeLast = lastNameOf(game.homeTeam.name).toLowerCase();
  // Require a minimum length so a short/common surname fragment can't false-match.
  if (awayLast.length < 3 || homeLast.length < 3) return false;
  return text.includes(awayLast) && text.includes(homeLast);
}

function marketYesSide(market: KalshiMarket, game: ArbGame): "away" | "home" | null {
  const text = market.yes_sub_title ?? "";
  if (!text.trim()) return null;
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const locationHit = (
    team: ArbGame["awayTeam"],
    other: ArbGame["homeTeam"]
  ): boolean => {
    const full = team.name.toLowerCase().trim();
    const short = team.shortName.toLowerCase().trim();
    const location = full.endsWith(` ${short}`) ? full.slice(0, -(short.length + 1)) : "";
    if (!location || !(normalized === location || normalized.startsWith(`${location} `))) return false;
    const otherFull = other.name.toLowerCase().trim();
    const otherShort = other.shortName.toLowerCase().trim();
    const otherLocation = otherFull.endsWith(` ${otherShort}`) ? otherFull.slice(0, -(otherShort.length + 1)) : "";
    if (location !== otherLocation) return true;
    const remainder = normalized.slice(location.length).trim();
    return remainder === short || remainder.startsWith(`${short} `) || remainder === short.charAt(0) || remainder.startsWith(`${short.charAt(0)} `);
  };
  const awayHit = teamMatchesTitle(
    game.awayTeam.name,
    game.awayTeam.shortName,
    game.awayTeam.abbreviation,
    text
  ) || locationHit(game.awayTeam, game.homeTeam);
  const homeHit = teamMatchesTitle(
    game.homeTeam.name,
    game.homeTeam.shortName,
    game.homeTeam.abbreviation,
    text
  ) || locationHit(game.homeTeam, game.awayTeam);
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

// ── Arbitrage support: every total line per game (not just the main line) ─────

export type VenueTotalLine = {
  line: number;
  overCents: number; // executable cost to BUY over, in cents (the ask)
  underCents: number; // executable cost to BUY under, in cents (the ask)
  overLiquidityUsd: number; // $ executable at the over ask (top of book)
  underLiquidityUsd: number; // $ executable at the under ask
  marketId: string;
  // Per-outcome native execution ids used only by live order placement:
  // Polymarket ERC-1155 CLOB token ids …
  overTokenId?: string;
  underTokenId?: string;
  // … and SX.bet's outcome-one mapping (which side "over" corresponds to).
  overIsOutcomeOne?: boolean;
  sourceStartTime?: string;
};

// A two-way market (moneyline) priced from each venue at the executable ask.
export type VenueTwoWay = {
  homeCents: number;
  awayCents: number;
  homeLiquidityUsd: number;
  awayLiquidityUsd: number;
  marketId: string;
  // Kalshi only: which team the market's YES side represents, so execution knows to
  // buy YES (that team) or NO (the other). Undefined for venues without a yes/no book.
  yesSide?: "home" | "away";
  // Polymarket CLOB token ids per outcome (live order placement only).
  homeTokenId?: string;
  awayTokenId?: string;
  // SX.bet: whether the HOME outcome is the market's outcome one.
  homeIsOutcomeOne?: boolean;
  // Soccer 1X2 ONLY — the draw outcome. Absent for every 2-way market (a venue that
  // sets these turns the moneyline into a 3-way market the arb engine treats as such).
  drawCents?: number;
  drawLiquidityUsd?: number;
  drawTokenId?: string; // native side id for the draw (Cloudbet market URL / SX outcome id)
  sourceStartTime?: string;
};

// Kalshi MLB moneyline per game (home/away buy costs at the ask). Reuses the same
// tuned team/side matching + top-of-book size logic as the totals fetch.
export async function fetchKalshiMoneylineByGame(
  games: ArbGame[],
  gameSeries: string = MLB_GAME_SERIES
): Promise<Map<string, VenueTwoWay>> {
  const result = new Map<string, VenueTwoWay>();
  if (!games.length) return result;

  const gameEvents = await fetchEventsBySeries(gameSeries);

  for (const game of games) {
    const markets = gameEvents
      .filter((ev) => eventMatchesGame(game, ev))
      .flatMap((ev) => ev.markets ?? []);

    // Pick the most liquid (tightest bid/ask) winner market with a known YES side.
    let best: { m: KalshiMarket; yesSide: "away" | "home"; bid: number; ask: number; spread: number } | null = null;
    for (const m of markets) {
      if (!isUsable(m)) continue;
      const yesSide = marketYesSide(m, game);
      if (!yesSide) continue;
      const { bid, ask } = readBidAsk(m);
      if (bid == null || ask == null) continue;
      const spread = ask - bid;
      if (!best || spread < best.spread) best = { m, yesSide, bid, ask, spread };
    }
    if (!best) continue;

    const { m, yesSide, bid, ask } = best;
    // Buy the YES-side team at the ask; buy the other team at the NO ask (1 - yes bid).
    const yesAskCents = Math.round(ask * 100);
    const noAskCents = Math.round((1 - bid) * 100);
    const yesSize = Number(m.yes_ask_size_fp ?? 0);
    const noSize = Number(m.yes_bid_size_fp ?? 0);
    const yesUsd = yesSize > 0 ? yesSize * ask : 1e9;
    const noUsd = noSize > 0 ? noSize * (1 - bid) : 1e9;

    result.set(game.id, {
      homeCents: yesSide === "home" ? yesAskCents : noAskCents,
      awayCents: yesSide === "away" ? yesAskCents : noAskCents,
      homeLiquidityUsd: yesSide === "home" ? yesUsd : noUsd,
      awayLiquidityUsd: yesSide === "away" ? yesUsd : noUsd,
      marketId: m.ticker,
      yesSide,
      sourceStartTime: kalshiTickerIsoDate(m.ticker) ?? undefined,
    });
  }

  return result;
}

// Kalshi F5 (first-5-innings) winner: THREE independent yes/no markets per game — one
// ticker for the home team, one for the away team, one for a tie — because a tie after 5
// innings is possible (unlike full game, where "the other team wins" is the complement of
// "this team wins"). Each market's own YES ask is that outcome's real price; unlike
// fetchKalshiMoneylineByGame, we do NOT derive one side from the other's complement
// (1 - bid) — that assumes only 2 possible outcomes, which is wrong once a tie exists (it
// would silently fold the tie's probability into whichever side we didn't have a direct
// quote for). yesSide is left undefined here to signal "read every outcome's own ticker" —
// see nativeSideFor / normalizeVenueTwoWay in ingest.ts.
export async function fetchKalshiThreeWayMoneylineByGame(
  games: ArbGame[],
  series: string = MLB_F5_GAME_SERIES
): Promise<Map<string, VenueTwoWay>> {
  const result = new Map<string, VenueTwoWay>();
  if (!games.length) return result;

  const events = await fetchEventsBySeries(series);

  for (const game of games) {
    const markets = events
      .filter((ev) => eventMatchesGame(game, ev))
      .flatMap((ev) => ev.markets ?? []);

    let homeM: KalshiMarket | undefined;
    let awayM: KalshiMarket | undefined;
    let tieM: KalshiMarket | undefined;
    for (const m of markets) {
      if (!isUsable(m)) continue;
      const side = marketYesSide(m, game);
      if (side === "home") homeM ??= m;
      else if (side === "away") awayM ??= m;
      else if (!tieM && /\btie\b/i.test(m.yes_sub_title ?? m.title ?? "")) tieM = m;
    }
    if (!homeM || !awayM || !tieM) continue; // unsafe unless every 1X2 outcome is priced

    const readOwnAsk = (m: KalshiMarket) => {
      const { ask } = readBidAsk(m);
      if (ask == null) return null;
      const size = Number(m.yes_ask_size_fp ?? 0);
      return { askCents: Math.round(ask * 100), usd: size > 0 ? size * ask : 1e9 };
    };
    const home = readOwnAsk(homeM);
    const away = readOwnAsk(awayM);
    if (!home || !away) continue;
    const tie = readOwnAsk(tieM);
    if (!tie) continue;

    result.set(game.id, {
      homeCents: home.askCents,
      awayCents: away.askCents,
      homeLiquidityUsd: home.usd,
      awayLiquidityUsd: away.usd,
      marketId: homeM.ticker,
      homeTokenId: homeM.ticker,
      awayTokenId: awayM.ticker,
      drawCents: tie.askCents,
      drawLiquidityUsd: tie.usd,
      drawTokenId: tieM.ticker,
      sourceStartTime: kalshiTickerIsoDate(homeM.ticker) ?? undefined,
    });
  }

  return result;
}

// Backward-compatible name for MLB F5 callers. Soccer 1X2 leagues use the generic
// three-way function above because their home/away/draw outcomes have the same native
// Kalshi shape: one independent YES ticker per possible result.
export const fetchKalshiF5MoneylineByGame = fetchKalshiThreeWayMoneylineByGame;

// Kalshi tennis match winner (KXWTAMATCH / KXATPMATCH): TWO INDEPENDENT per-player
// tickers, mutually exclusive — the SAME shape as fetchKalshiF5MoneylineByGame (read each
// outcome's own yes ask directly, no 1-bid complement derivation), for the same reason: a
// generic "one ticker + NO=complement" reader would only coincidentally be right here.
// Verified live 2026-08-09 against KXWTAMATCH-26AUG09SAMRYB: two markets,
// "...-SAM" and "...-RYB", each independently priced (13-14c / 88-89c, summing to ~100%
// but never assumed to). No tie market (unlike F5) — tennis has no draw.
export async function fetchKalshiIndependentMoneylineByGame(
  games: ArbGame[],
  series: string,
  tennisNames = false
): Promise<Map<string, VenueTwoWay>> {
  const result = new Map<string, VenueTwoWay>();
  if (!games.length) return result;

  const events = await fetchEventsBySeries(series);

  for (const game of games) {
    const markets = events
      .filter((ev) => tennisNames ? eventMatchesTennisGame(game, ev) : eventMatchesGame(game, ev))
      .flatMap((ev) => ev.markets ?? []);

    let homeM: KalshiMarket | undefined;
    let awayM: KalshiMarket | undefined;
    for (const m of markets) {
      if (!isUsable(m)) continue;
      const side = marketYesSide(m, game);
      if (side === "home") homeM ??= m;
      else if (side === "away") awayM ??= m;
    }
    if (!homeM || !awayM) continue; // need both players priced to hedge

    const readOwnAsk = (m: KalshiMarket) => {
      const { ask } = readBidAsk(m);
      if (ask == null) return null;
      const size = Number(m.yes_ask_size_fp ?? 0);
      return { askCents: Math.round(ask * 100), usd: size > 0 ? size * ask : 1e9 };
    };
    const home = readOwnAsk(homeM);
    const away = readOwnAsk(awayM);
    if (!home || !away) continue;

    result.set(game.id, {
      homeCents: home.askCents,
      awayCents: away.askCents,
      homeLiquidityUsd: home.usd,
      awayLiquidityUsd: away.usd,
      marketId: homeM.ticker,
      homeTokenId: homeM.ticker,
      awayTokenId: awayM.ticker,
      sourceStartTime: kalshiTickerIsoDate(homeM.ticker) ?? undefined,
    });
  }

  return result;
}

// Backward-compatible tennis-specific wrapper. Team sports such as NFL preseason can
// use the generic reader directly when a venue publishes one YES ticker per team.
export function fetchKalshiPlayerMatchByGame(
  games: ArbGame[],
  series: string
): Promise<Map<string, VenueTwoWay>> {
  return fetchKalshiIndependentMoneylineByGame(games, series, true);
}

// A spread (runline) market: home/away cover costs + the SIGNED home line (e.g.
// -1.5 if home is favored, +1.5 if home is the underdog) so settlement can grade it.
export type VenueSpread = VenueTwoWay & { homeSignedLine: number };

// Kalshi MLB runline (1.5). YES = named team covers -1.5. Maps to home/away cover.
export async function fetchKalshiSpreadByGame(
  games: ArbGame[],
  spreadSeries: string = MLB_SPREAD_SERIES,
  fixedLine: number | undefined = 1.5
): Promise<Map<string, VenueSpread>> {
  const result = new Map<string, VenueSpread>();
  if (!games.length) return result;

  const events = await fetchEventsBySeries(spreadSeries);

  for (const game of games) {
    const markets = events
      .filter((ev) => eventMatchesGame(game, ev))
      .flatMap((ev) => ev.markets ?? []);

    let best: { m: KalshiMarket; yesSide: "away" | "home"; bid: number; ask: number; line: number; spread: number } | null = null;
    for (const m of markets) {
      if (!isUsable(m)) continue;
      const line = extractSpreadLine(m);
      const yesSide = marketYesSide(m, game);
      if (line == null || yesSide == null) continue;
      // MLB has a fixed 1.5 run-line; other sports use variable point spreads —
      // in that case take the most liquid line (tightest bid/ask) instead.
      if (fixedLine != null && Math.abs(line - fixedLine) > 0.01) continue;
      const { bid, ask } = readBidAsk(m);
      if (bid == null || ask == null) continue;
      const spread = ask - bid;
      if (!best || spread < best.spread) best = { m, yesSide, bid, ask, line, spread };
    }
    if (!best) continue;

    const { m, yesSide, bid, ask, line } = best;
    const yesAskCents = Math.round(ask * 100);
    const noAskCents = Math.round((1 - bid) * 100);
    const yesSize = Number(m.yes_ask_size_fp ?? 0);
    const noSize = Number(m.yes_bid_size_fp ?? 0);
    const yesUsd = yesSize > 0 ? yesSize * ask : 1e9;
    const noUsd = noSize > 0 ? noSize * (1 - bid) : 1e9;

    result.set(game.id, {
      homeCents: yesSide === "home" ? yesAskCents : noAskCents,
      awayCents: yesSide === "away" ? yesAskCents : noAskCents,
      homeLiquidityUsd: yesSide === "home" ? yesUsd : noUsd,
      awayLiquidityUsd: yesSide === "away" ? yesUsd : noUsd,
      homeSignedLine: yesSide === "home" ? -line : line,
      marketId: m.ticker,
      yesSide,
      sourceStartTime: kalshiTickerIsoDate(m.ticker) ?? undefined,
    });
  }

  return result;
}

// Returns ALL total lines Kalshi offers for each game, keyed by ESPN gameId. The
// arb matching engine needs the full ladder so it can pair the same line across
// venues — unlike buildTotal(), which collapses to a single main line for the UI.
export async function fetchKalshiTotalsByGame(
  games: ArbGame[],
  totalSeries: string = MLB_TOTAL_SERIES
): Promise<Map<string, VenueTotalLine[]>> {
  const result = new Map<string, VenueTotalLine[]>();
  if (!games.length) return result;

  const totalEvents = await fetchEventsBySeries(totalSeries);

  for (const game of games) {
    const events = totalEvents.filter((ev) => eventMatchesGame(game, ev));
    if (!events.length) continue;

    // line -> best (tightest bid/ask) quote, so duplicate markets collapse per line.
    // Kalshi total YES = OVER, so the executable buy costs are:
    //   overCost  = yes_ask         (pay the ask to buy YES/over)
    //   underCost = 1 - yes_bid     (the NO ask = 1 minus the YES bid)
    // Falls back to mid only when a side is one-sided/missing.
    type Q = { overAsk: number; underAsk: number; overUsd: number; underUsd: number; spread: number; ticker: string };
    const byLine = new Map<number, Q>();
    for (const ev of events) {
      for (const m of ev.markets ?? []) {
        if (!isUsable(m)) continue;
        const line = extractTotalLine(m);
        const mid = midPrice(m);
        if (line == null || mid == null) continue;
        const { bid, ask } = readBidAsk(m);
        const overAsk = ask != null ? ask : mid;
        const underAsk = bid != null ? 1 - bid : 1 - mid;
        const spread = bid != null && ask != null ? ask - bid : Infinity;
        // Executable $ at top of book: OVER fills against the yes ask (yes_ask_size),
        // UNDER fills against the no ask = yes bid resting size (yes_bid_size).
        const overSize = Number(m.yes_ask_size_fp ?? 0);
        const underSize = Number(m.yes_bid_size_fp ?? 0);
        // Large sentinel when size is unavailable (JSON-safe, unlike Infinity) — the
        // cross-venue min then defers to the other leg's real liquidity.
        const overUsd = overSize > 0 ? overSize * overAsk : 1e9;
        const underUsd = underSize > 0 ? underSize * underAsk : 1e9;
        const prev = byLine.get(line);
        if (!prev || spread < prev.spread) {
          byLine.set(line, { overAsk, underAsk, overUsd, underUsd, spread, ticker: m.ticker });
        }
      }
    }

    if (byLine.size === 0) continue;
    const lines: VenueTotalLine[] = [...byLine.entries()].map(([line, q]) => ({
      line,
      overCents: Math.round(q.overAsk * 100),
      underCents: Math.round(q.underAsk * 100),
      overLiquidityUsd: q.overUsd,
      underLiquidityUsd: q.underUsd,
      marketId: q.ticker,
      sourceStartTime: kalshiTickerIsoDate(q.ticker) ?? undefined,
    }));
    result.set(game.id, lines);
  }

  return result;
}

export { fetchSportSeries };
