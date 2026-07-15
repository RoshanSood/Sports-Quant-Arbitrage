import { teamMatchesTitle, teamsMatch } from "./teamNormalization";
import type { ArbGame } from "./arbitrage/sports";
import type { VenueSpread, VenueTotalLine, VenueTwoWay } from "./kalshi";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

type GammaMarket = {
  id: string;
  question: string;
  gameStartTime?: string;
  outcomes?: string;
  clobTokenIds?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number };
};

type GammaEvent = {
  id: string;
  title: string;
  startDate?: string;
  startTime?: string;
  eventDate?: string;
  endDate?: string;
  markets?: GammaMarket[];
};

type BookLevel = { price: string; size: string };
type ClobBook = { asset_id: string; asks?: BookLevel[] };
type OutcomeQuote = { tokenId: string; priceCents: number; liquidityUsd: number };
type MarketKind = "moneyline" | "spread" | "total" | null;

export type PolymarketArbMarkets = {
  moneyline: Map<string, VenueTwoWay>;
  spread: Map<string, VenueSpread>;
  totals: Map<string, VenueTotalLine[]>;
};

function parseJsonArray(value?: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
function outcomesAndTokens(market: GammaMarket): Array<{ outcome: string; tokenId: string }> {
  const outcomes = parseJsonArray(market.outcomes);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  if (outcomes.length === tokenIds.length && outcomes.length >= 2) {
    return outcomes.map((outcome, index) => ({ outcome, tokenId: tokenIds[index] }));
  }
  return (market.tokens ?? []).map((token) => ({ outcome: token.outcome, tokenId: token.token_id }));
}

function classifyMarket(market: GammaMarket): MarketKind {
  const question = market.question.toLowerCase();
  // Keep period and player derivatives out of full-game comparisons.
  if (/\b(?:innings?|quarter|half|period|player|1st|2nd|3rd|4th|first|second|third|fourth)\b/.test(question)) {
    return null;
  }
  if (/o\/u|over|under/.test(question) && !question.includes("spread")) return "total";
  if (question.includes("spread:")) return "spread";
  const outcomeLabels = outcomesAndTokens(market).map(({ outcome }) => outcome.toLowerCase());
  if (
    outcomeLabels.length === 2 &&
    !outcomeLabels.every((outcome) => outcome === "yes" || outcome === "no") &&
    !/inning|runs?|hits?|strikeouts?|score|quarter|half/.test(question)
  ) {
    return "moneyline";
  }
  return null;
}

function eventGameTime(event: GammaEvent): number {
  const raw = event.startTime ?? event.markets?.find((market) => market.gameStartTime)?.gameStartTime ?? event.eventDate ?? event.startDate ?? "";
  return Date.parse(raw);
}

function eventMatchesGame(event: GammaEvent, game: ArbGame): boolean {
  return (
    teamMatchesTitle(game.awayTeam.name, game.awayTeam.shortName, game.awayTeam.abbreviation, event.title) &&
    teamMatchesTitle(game.homeTeam.name, game.homeTeam.shortName, game.homeTeam.abbreviation, event.title)
  );
}

function totalMatchesGame(market: GammaMarket, game: ArbGame): boolean {
  return (
    teamMatchesTitle(game.awayTeam.name, game.awayTeam.shortName, game.awayTeam.abbreviation, market.question) &&
    teamMatchesTitle(game.homeTeam.name, game.homeTeam.shortName, game.homeTeam.abbreviation, market.question)
  );
}

function pickEvent(events: GammaEvent[], game: ArbGame): GammaEvent | null {
  const candidates = events.filter((event) => eventMatchesGame(event, game));
  if (candidates.length === 0) return null;
  const gameTime = Date.parse(game.startTimeIso);

  return candidates.sort((a, b) => {
    const aTime = eventGameTime(a);
    const bTime = eventGameTime(b);
    const aDelta = Number.isFinite(gameTime) && Number.isFinite(aTime) ? Math.abs(aTime - gameTime) : Number.MAX_SAFE_INTEGER;
    const bDelta = Number.isFinite(gameTime) && Number.isFinite(bTime) ? Math.abs(bTime - gameTime) : Number.MAX_SAFE_INTEGER;
    if (aDelta !== bDelta) return aDelta - bDelta;
    const aKinds = new Set((a.markets ?? []).map(classifyMarket).filter(Boolean)).size;
    const bKinds = new Set((b.markets ?? []).map(classifyMarket).filter(Boolean)).size;
    return bKinds - aKinds;
  })[0];
}

async function fetchEvents(tag: string, games: ArbGame[]): Promise<GammaEvent[]> {
  const params = new URLSearchParams({ tag_slug: tag, closed: "false", limit: "500" });
  const gameTimes = games.map((game) => Date.parse(game.startTimeIso)).filter(Number.isFinite);
  if (gameTimes.length > 0) {
    const paddingMs = 12 * 60 * 60 * 1000;
    params.set("start_time_min", new Date(Math.min(...gameTimes) - paddingMs).toISOString());
    params.set("start_time_max", new Date(Math.max(...gameTimes) + paddingMs).toISOString());
  }
  const response = await fetch(`${GAMMA_API}/events?${params}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Polymarket Gamma ${response.status}`);
  const body = await response.json();
  const events = Array.isArray(body) ? body : body?.events;
  return Array.isArray(events) ? (events as GammaEvent[]) : [];
}

async function fetchBooks(tokenIds: string[]): Promise<Map<string, ClobBook>> {
  const books = new Map<string, ClobBook>();
  const unique = [...new Set(tokenIds.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 500) {
    const batch = unique.slice(index, index + 500);
    const response = await fetch(`${CLOB_API}/books`, {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(batch.map((token_id) => ({ token_id }))),
    });
    if (!response.ok) throw new Error(`Polymarket CLOB ${response.status}`);
    const body = await response.json();
    for (const book of (Array.isArray(body) ? body : body?.data ?? []) as ClobBook[]) {
      if (book.asset_id) books.set(book.asset_id, book);
    }
  }
  return books;
}

function topAsk(tokenId: string, books: Map<string, ClobBook>): OutcomeQuote | null {
  const levels = (books.get(tokenId)?.asks ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  if (levels.length === 0) return null;
  const bestPrice = levels[0].price;
  const size = levels.filter((level) => level.price === bestPrice).reduce((sum, level) => sum + level.size, 0);
  return {
    tokenId,
    priceCents: Number((bestPrice * 100).toFixed(4)),
    liquidityUsd: Number((bestPrice * size).toFixed(4)),
  };
}

function quoteForOutcome(
  market: GammaMarket,
  books: Map<string, ClobBook>,
  predicate: (outcome: string) => boolean
): OutcomeQuote | null {
  const token = outcomesAndTokens(market).find(({ outcome }) => predicate(outcome));
  return token ? topAsk(token.tokenId, books) : null;
}

function isTeamOutcome(outcome: string, team: ArbGame["homeTeam"]): boolean {
  const words = outcome.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return teamsMatch(outcome, team.name) || teamsMatch(outcome, team.shortName) || words.includes(team.abbreviation.toUpperCase());
}

function marketFeeRate(market: GammaMarket): number | undefined {
  if (market.feesEnabled === false) return 0;
  const rate = Number(market.feeSchedule?.rate);
  return Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}

// One Gamma request and one batched CLOB request supply all three market types.
export async function fetchPolymarketArbMarkets(
  games: ArbGame[],
  tag = "mlb"
): Promise<PolymarketArbMarkets> {
  const result: PolymarketArbMarkets = {
    moneyline: new Map(),
    spread: new Map(),
    totals: new Map(),
  };
  if (games.length === 0) return result;

  const events = await fetchEvents(tag, games);
  const selected = new Map<string, GammaEvent>();
  const tokenIds: string[] = [];
  for (const game of games) {
    const event = pickEvent(events, game);
    if (!event) continue;
    selected.set(game.id, event);
    for (const market of event.markets ?? []) {
      const kind = classifyMarket(market);
      if (kind && (kind !== "total" || totalMatchesGame(market, game))) {
        tokenIds.push(...outcomesAndTokens(market).map((token) => token.tokenId));
      }
    }
  }

  const books = await fetchBooks(tokenIds);
  for (const game of games) {
    const event = selected.get(game.id);
    if (!event) continue;
    const markets = event.markets ?? [];

    for (const moneyline of markets.filter((market) => classifyMarket(market) === "moneyline")) {
      const home = quoteForOutcome(moneyline, books, (outcome) => isTeamOutcome(outcome, game.homeTeam));
      const away = quoteForOutcome(moneyline, books, (outcome) => isTeamOutcome(outcome, game.awayTeam));
      if (home && away) {
        result.moneyline.set(game.id, {
          homeCents: home.priceCents,
          awayCents: away.priceCents,
          homeLiquidityUsd: home.liquidityUsd,
          awayLiquidityUsd: away.liquidityUsd,
          marketId: moneyline.id,
          feeRate: marketFeeRate(moneyline),
          homeNativeMarketId: home.tokenId,
          awayNativeMarketId: away.tokenId,
          // CLOB token id per outcome — live order placement signs against this.
          homeTokenId: home.tokenId,
          awayTokenId: away.tokenId,
        });
        break;
      }
    }

    for (const spread of markets.filter((market) => classifyMarket(market) === "spread")) {
      const home = quoteForOutcome(spread, books, (outcome) => isTeamOutcome(outcome, game.homeTeam));
      const away = quoteForOutcome(spread, books, (outcome) => isTeamOutcome(outcome, game.awayTeam));
      const lineMatch = spread.question.match(/([+-]?\d+(?:\.\d+)?)/);
      if (home && away && lineMatch) {
        const namedLine = Number(lineMatch[1]);
        const namesAway = teamMatchesTitle(
          game.awayTeam.name,
          game.awayTeam.shortName,
          game.awayTeam.abbreviation,
          spread.question
        );
        result.spread.set(game.id, {
          homeCents: home.priceCents,
          awayCents: away.priceCents,
          homeLiquidityUsd: home.liquidityUsd,
          awayLiquidityUsd: away.liquidityUsd,
          homeSignedLine: namesAway ? -namedLine : namedLine,
          marketId: spread.id,
          feeRate: marketFeeRate(spread),
          homeNativeMarketId: home.tokenId,
          awayNativeMarketId: away.tokenId,
          homeTokenId: home.tokenId,
          awayTokenId: away.tokenId,
        });
        break;
      }
    }

    const totals: VenueTotalLine[] = [];
    for (const total of markets.filter(
      (market) => classifyMarket(market) === "total" && totalMatchesGame(market, game)
    )) {
      const lineMatches = total.question.match(/\d+(?:\.\d+)?/g);
      const line = lineMatches ? Number(lineMatches[lineMatches.length - 1]) : Number.NaN;
      const over = quoteForOutcome(total, books, (outcome) => /^(over|yes)$/i.test(outcome));
      const under = quoteForOutcome(total, books, (outcome) => /^(under|no)$/i.test(outcome));
      if (!Number.isFinite(line) || !over || !under) continue;
      totals.push({
        line,
        overCents: over.priceCents,
        underCents: under.priceCents,
        overLiquidityUsd: over.liquidityUsd,
        underLiquidityUsd: under.liquidityUsd,
        marketId: total.id,
        feeRate: marketFeeRate(total),
        overNativeMarketId: over.tokenId,
        underNativeMarketId: under.tokenId,
        overTokenId: over.tokenId,
        underTokenId: under.tokenId,
      });
    }
    if (totals.length > 0) result.totals.set(game.id, totals);
  }

  return result;
}
