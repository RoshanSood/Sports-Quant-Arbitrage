import { GameMarket, OddsOption } from "@/types";
import { WNBAGame } from "@/types/wnba";
import { wnbaTeamMatchesTitle } from "./wnbaTeams";
import { kalshiGet } from "./kalshiAuth";

const WNBA_GAME_SERIES   = "KXWNBAGAME";
const WNBA_SPREAD_SERIES = "KXWNBASPREAD";
const WNBA_TOTAL_SERIES  = "KXWNBATOTAL";

type KalshiMarket = {
  ticker: string;
  event_ticker: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  yes_bid?: number;
  yes_ask?: number;
  last_price?: number;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  last_price_dollars?: string | number;
  volume?: number;
};

type KalshiEvent = {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  markets?: KalshiMarket[];
};

type EventsResponse = { events: KalshiEvent[]; cursor?: string };

async function fetchEvents(seriesTicker: string): Promise<KalshiEvent[]> {
  const params = new URLSearchParams({
    series_ticker: seriesTicker,
    status: "open",
    with_nested_markets: "true",
    limit: "200",
  });
  try {
    const data = await kalshiGet<EventsResponse>(`/events?${params}`, { revalidate: 120 });
    return data.events ?? [];
  } catch (err) {
    console.error(`[Kalshi WNBA] events fetch failed (${seriesTicker}):`, err);
    return [];
  }
}

// ── Pricing ──────────────────────────────────────────────────────────────────

function readBidAsk(m: KalshiMarket): { bid: number | null; ask: number | null } {
  let bid: number | null = null;
  let ask: number | null = null;
  if (m.yes_bid_dollars != null) {
    const n = Number(m.yes_bid_dollars);
    if (Number.isFinite(n)) bid = n;
  } else if (m.yes_bid != null) {
    bid = m.yes_bid / 100;
  }
  if (m.yes_ask_dollars != null) {
    const n = Number(m.yes_ask_dollars);
    if (Number.isFinite(n)) ask = n;
  } else if (m.yes_ask != null) {
    ask = m.yes_ask / 100;
  }
  return { bid, ask };
}

function readYesPrice(m: KalshiMarket): number | null {
  const { bid, ask } = readBidAsk(m);
  if (bid != null && ask != null) return parseFloat(((bid + ask) / 2).toFixed(4));
  if (bid != null) return bid;
  if (ask != null) return ask;
  if (m.last_price_dollars != null) {
    const n = Number(m.last_price_dollars);
    if (Number.isFinite(n)) return n;
  }
  if (m.last_price != null && Number.isFinite(m.last_price)) return m.last_price / 100;
  return null;
}

function isUsable(m: KalshiMarket): boolean {
  if (m.status === "settled" || m.status === "closed") return false;
  return readYesPrice(m) != null;
}

function priceToDisplayCents(p: number | null): string {
  return p == null ? "N/A" : `${Math.round(p * 100)}¢`;
}

function formatVolume(v: number | null | undefined): string | null {
  if (!v) return null;
  return v >= 1000 ? `$${(v / 1000).toFixed(2)}K` : `$${v.toFixed(0)}`;
}

// ── Team matching ────────────────────────────────────────────────────────────

function eventMatchesGame(game: WNBAGame, event: KalshiEvent): boolean {
  const text = `${event.title ?? ""} ${event.sub_title ?? ""}`;
  if (!text.trim()) return false;
  const away = wnbaTeamMatchesTitle(
    game.awayTeam.name,
    game.awayTeam.shortName,
    game.awayTeam.abbreviation,
    text
  );
  const home = wnbaTeamMatchesTitle(
    game.homeTeam.name,
    game.homeTeam.shortName,
    game.homeTeam.abbreviation,
    text
  );
  return away && home;
}

function marketYesSide(m: KalshiMarket, game: WNBAGame): "away" | "home" | null {
  const text = m.yes_sub_title ?? "";
  if (!text.trim()) return null;
  const away = wnbaTeamMatchesTitle(
    game.awayTeam.name,
    game.awayTeam.shortName,
    game.awayTeam.abbreviation,
    text
  );
  const home = wnbaTeamMatchesTitle(
    game.homeTeam.name,
    game.homeTeam.shortName,
    game.homeTeam.abbreviation,
    text
  );
  if (away && !home) return "away";
  if (home && !away) return "home";
  return null;
}

// ── Line extraction ──────────────────────────────────────────────────────────

function extractLine(m: KalshiMarket): number | null {
  const text = `${m.title ?? ""} ${m.subtitle ?? ""} ${m.yes_sub_title ?? ""}`;
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// ── Builders ─────────────────────────────────────────────────────────────────

function buildMoneyline(markets: KalshiMarket[], game: WNBAGame): OddsOption[] {
  for (const m of markets) {
    if (!isUsable(m)) continue;
    const side = marketYesSide(m, game);
    if (!side) continue;
    const yes = readYesPrice(m);
    if (yes == null) continue;
    const no = parseFloat((1 - yes).toFixed(4));
    const yesOpt: OddsOption = {
      label: side === "away" ? game.awayTeam.abbreviation : game.homeTeam.abbreviation,
      price: yes,
      displayPrice: priceToDisplayCents(yes),
    };
    const noOpt: OddsOption = {
      label: side === "away" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation,
      price: no,
      displayPrice: priceToDisplayCents(no),
    };
    return side === "away" ? [yesOpt, noOpt] : [noOpt, yesOpt];
  }
  return [];
}

// Kalshi spread format: "TEAM wins by over N.5 points"
// YES = TEAM covers -N.5; pick the most liquid market (tightest bid/ask).
function buildSpread(markets: KalshiMarket[], game: WNBAGame): OddsOption[] {
  type Candidate = {
    m: KalshiMarket;
    line: number;
    yesSide: "away" | "home";
    mid: number;
    spread: number;
  };

  const candidates: Candidate[] = [];
  for (const m of markets) {
    if (m.status === "settled" || m.status === "closed") continue;
    const { bid, ask } = readBidAsk(m);
    if (bid == null || ask == null || bid < 0.05) continue;
    const line = extractLine(m);
    const yesSide = marketYesSide(m, game);
    if (line == null || yesSide == null) continue;
    candidates.push({ m, line, yesSide, mid: (bid + ask) / 2, spread: ask - bid });
  }

  if (!candidates.length) return [];

  // Tightest spread = most liquid = most representative market
  candidates.sort((a, b) => a.spread - b.spread);
  const pick = candidates[0];

  const yes = readYesPrice(pick.m);
  if (yes == null) return [];
  const no = parseFloat((1 - yes).toFixed(4));
  const lineMag = Math.abs(pick.line);
  const yesIsAway = pick.yesSide === "away";
  const awayLine = yesIsAway ? -lineMag : lineMag;
  const homeLine = -awayLine;
  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);

  return [
    {
      label: `${game.awayTeam.abbreviation} ${fmt(awayLine)}`,
      price: yesIsAway ? yes : no,
      displayPrice: priceToDisplayCents(yesIsAway ? yes : no),
    },
    {
      label: `${game.homeTeam.abbreviation} ${fmt(homeLine)}`,
      price: yesIsAway ? no : yes,
      displayPrice: priceToDisplayCents(yesIsAway ? no : yes),
    },
  ];
}

// Kalshi total format: "Over N.5 points scored" where YES = over, NO = under.
// Pick the most liquid market (tightest bid/ask), breaking ties by closest to 50¢.
function buildTotal(markets: KalshiMarket[]): OddsOption[] {
  type Candidate = { m: KalshiMarket; line: number; mid: number; spread: number };
  const candidates: Candidate[] = [];

  for (const m of markets) {
    if (m.status === "settled" || m.status === "closed") continue;
    const { bid, ask } = readBidAsk(m);
    if (bid == null || ask == null || bid < 0.05) continue;
    const line = extractLine(m);
    if (line == null) continue;
    candidates.push({ m, line, mid: (bid + ask) / 2, spread: ask - bid });
  }

  if (!candidates.length) return [];

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

// ── Top-level ─────────────────────────────────────────────────────────────────

export async function fetchKalshiWnbaData(
  games: WNBAGame[]
): Promise<Map<string, GameMarket>> {
  if (!games.length) return new Map();

  const [gameEvents, spreadEvents, totalEvents] = await Promise.all([
    fetchEvents(WNBA_GAME_SERIES),
    fetchEvents(WNBA_SPREAD_SERIES),
    fetchEvents(WNBA_TOTAL_SERIES),
  ]);

  const map = new Map<string, GameMarket>();
  for (const game of games) {
    const mlEvents  = gameEvents.filter((ev) => eventMatchesGame(game, ev));
    const spEvents  = spreadEvents.filter((ev) => eventMatchesGame(game, ev));
    const totEvents = totalEvents.filter((ev) => eventMatchesGame(game, ev));

    if (!mlEvents.length && !spEvents.length && !totEvents.length) continue;

    const mlMarkets  = mlEvents.flatMap((ev) => ev.markets ?? []);
    const spMarkets  = spEvents.flatMap((ev) => ev.markets ?? []);
    const totMarkets = totEvents.flatMap((ev) => ev.markets ?? []);
    const volume = [...mlMarkets, ...spMarkets, ...totMarkets].reduce(
      (s, m) => s + (m.volume ?? 0),
      0
    );

    const market: GameMarket = {
      moneyline: buildMoneyline(mlMarkets, game),
      spread: buildSpread(spMarkets, game),
      total: buildTotal(totMarkets),
      volume: formatVolume(volume),
    };

    if (market.moneyline.length > 0 || market.spread.length > 0 || market.total.length > 0) {
      map.set(game.id, market);
    }
  }
  return map;
}
