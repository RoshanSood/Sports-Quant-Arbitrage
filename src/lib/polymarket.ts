import { GameMarket, MLBGame, OddsOption } from "@/types";
import { resolveTwoWayTeamOrder, teamMatchesTitle, teamsMatch } from "./teamNormalization";
import type { VenueTotalLine, VenueTwoWay, VenueSpread } from "./kalshi";
import type { ArbGame } from "./arbitrage/sports";
import { pacificDateFromIso } from "./arbitrage/date";
import { classifyMarketSegment } from "./arbitrage/marketSegment";
import type { MarketSegment } from "@/types/arbitrage";

const GAMMA_API = "https://gamma-api.polymarket.com";

type PolymarketMarket = {
  id: string;
  question: string;
  volume?: string;
  outcomes?: string;
  outcomePrices?: string;
  bestBid?: number; // best bid for the first-outcome token (Gamma)
  bestAsk?: number; // best ask for the first-outcome token (Gamma)
  liquidityNum?: number; // $ liquidity resting in the CLOB book (Gamma)
  tokens?: Array<{ token_id: string; outcome: string; price?: number }>;
  clobTokenIds?: string; // JSON array of ERC-1155 token ids, parallel to `outcomes`
  slug?: string;
  gameStartTime?: string;
  startDate?: string;
  endDate?: string;
};

type PolymarketEvent = {
  id: string;
  title: string;
  slug: string;
  markets: PolymarketMarket[];
  volume?: string;
  startDate?: string;
  endDate?: string;
  eventDate?: string;
  startTime?: string;
};

// Fetch all open game-level events from Polymarket for a tag (mlb, wnba, …).
async function fetchMLBEvents(tag: string = "mlb"): Promise<PolymarketEvent[]> {
  const params = new URLSearchParams({
    tag_slug: tag,
    closed: "false",
    limit: "200",
  });

  try {
    // Response is ~11MB — bigger than Next.js's 2MB data-cache limit.
    // `cache: "no-store"` skips that cache layer entirely.
    const res = await fetch(`${GAMMA_API}/events?${params}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("[Polymarket] fetch failed:", res.status);
      return [];
    }
    const data = await res.json();
    const events: PolymarketEvent[] = Array.isArray(data) ? data : data.events || [];
    return events;
  } catch (err) {
    console.error("[Polymarket] fetch error:", err);
    return [];
  }
}

// Pick the best matching event for a game on a specific date.
//
// Problem: Polymarket creates multiple events per series. Newer (lower-volume) events
// often have only a moneyline market while the older higher-volume event has the full
// moneyline + spread + total set. Sorting purely by newest startDate picks the wrong
// event and results in missing spread/total data.
//
// Fix: score events by number of distinct market types (moneyline/spread/total), prefer
// the most complete event, and break ties by most recent startDate.
function dateOnly(value: string | undefined): string | null {
  if (!value) return null;
  return value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

function slugDate(slug: string | undefined): string | null {
  return slug?.match(/(\d{4}-\d{2}-\d{2})(?:$|-)/)?.[1] ?? null;
}

function polymarketGameDate(ev: PolymarketEvent): string | null {
  // Derive the PACIFIC calendar day from the event's timestamps (was dateOnly = raw UTC
  // date, which mismatched the now-Pacific game.date and matched tomorrow's market to
  // tonight's game). Slug dates are already bare calendar dates and pass through unchanged.
  return (
    pacificDateFromIso(ev.eventDate) ??
    pacificDateFromIso(ev.startTime) ??
    slugDate(ev.slug) ??
    (ev.markets ?? []).map((m) => pacificDateFromIso(m.gameStartTime)).find(Boolean) ??
    (ev.markets ?? []).map((m) => slugDate(m.slug)).find(Boolean) ??
    null
  );
}

function eventDateMatches(ev: PolymarketEvent, gameDate: string): boolean {
  return polymarketGameDate(ev) === gameDate;
}

function pickBestEvent(
  matched: PolymarketEvent[],
  gameDate: string // YYYY-MM-DD
): PolymarketEvent | null {
  const pool = matched.filter((ev) => eventDateMatches(ev, gameDate));
  if (pool.length === 0) return null;
  const livePool = pool.filter(eventHasLivePrices);
  const sortPool = livePool.length > 0 ? livePool : pool;

  // Count distinct non-null market types in each event
  const typeScore = (ev: PolymarketEvent): number => {
    const types = new Set<MarketType>();
    for (const m of ev.markets ?? []) {
      const t = classifyMarket(m);
      if (t) types.add(t);
    }
    return types.size;
  };

  // Prefer most-complete events; among ties pick newest startDate
  const maxScore = Math.max(...sortPool.map(typeScore), 0);
  const bestPool = sortPool.filter((ev) => typeScore(ev) >= maxScore);
  return bestPool.sort((a, b) =>
    (b.startDate ?? "").slice(0, 10).localeCompare((a.startDate ?? "").slice(0, 10))
  )[0];
}

function priceToDisplayCents(price: number | null | undefined): string {
  if (price == null) return "N/A";
  return `${Math.round(price * 100)}¢`;
}

function parseOutcomes(market: PolymarketMarket): {
  outcomes: string[];
  prices: (number | null)[];
  tokenIds: (string | null)[];
} {
  let outcomes: string[] = [];
  let prices: (number | null)[] = [];
  let tokenIds: (string | null)[] = [];

  try {
    if (market.outcomes) outcomes = JSON.parse(market.outcomes);
    if (market.outcomePrices) {
      prices = JSON.parse(market.outcomePrices).map((p: string | null) =>
        p != null && p !== "" ? Number(p) : null
      );
    }
    // clobTokenIds is a JSON string array parallel to `outcomes` — the ERC-1155 asset
    // id per outcome, which live order placement signs against.
    if (market.clobTokenIds) tokenIds = JSON.parse(market.clobTokenIds);
  } catch {
    // ignore
  }

  if (outcomes.length === 0 && market.tokens) {
    outcomes = market.tokens.map((t) => t.outcome);
    prices = market.tokens.map((t) => t.price ?? null);
  }
  if (tokenIds.length === 0 && market.tokens) {
    tokenIds = market.tokens.map((t) => t.token_id ?? null);
  }

  return { outcomes, prices, tokenIds };
}

// Resolve the token id for a named outcome ("over"/"under"/"yes"/"no" or a team).
function tokenIdFor(
  outcomes: string[],
  tokenIds: (string | null)[],
  match: (label: string) => boolean
): string | undefined {
  const i = outcomes.findIndex((o) => match(o.toLowerCase()));
  return i >= 0 ? tokenIds[i] ?? undefined : undefined;
}

function formatVolume(vol: string | number | null | undefined): string | null {
  if (vol == null) return null;
  const num = typeof vol === "string" ? parseFloat(vol) : vol;
  if (isNaN(num) || num === 0) return null;
  if (num >= 1000) return `$${(num / 1000).toFixed(2)}K`;
  return `$${num.toFixed(0)}`;
}

type MarketType = "moneyline" | "spread" | "total" | null;

function classifyMarket(market: PolymarketMarket): MarketType {
  // Only full-game and F5 markets are tradeable (see marketSegment.ts) — every other
  // partial-game segment (a single inning, a half, a period, F3/F7) is dropped here so it
  // can never be matched against a full-game or F5 line it doesn't actually share.
  if (classifyMarketSegment(market.question) === null) return null;
  const q = market.question.toLowerCase();
  // Game events also contain team totals. They are not complementary with the
  // full-game total and must never enter the shared over/under ladder.
  if (/\bteam total\b/.test(q)) return null;
  if (/o\/u|over|under/.test(q) && !q.includes("spread")) return "total";
  if (q.startsWith("spread:") || q.includes("spread:")) return "spread";
  // 2-outcome markets without game-prop keywords → moneyline
  const { outcomes } = parseOutcomes(market);
  if (
    outcomes.length === 2 &&
    !q.includes("inning") &&
    !q.includes("run") &&
    !q.includes("hit") &&
    !q.includes("strikeout") &&
    !q.includes("score")
  ) {
    return "moneyline";
  }
  return null;
}

function signedLine(val: number): string {
  return val > 0 ? `+${val}` : `${val}`;
}

// Build moneyline options in [away, home] order
function buildMoneylineOptions(
  market: PolymarketMarket,
  awayAbbr: string,
  homeAbbr: string,
  awayName: string,
): OddsOption[] {
  const { outcomes, prices } = parseOutcomes(market);

  const mapped = outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const matchesAway =
      teamsMatch(outcome, awayName) ||
      outcome.toLowerCase().includes(awayAbbr.toLowerCase());
    return {
      label: matchesAway ? awayAbbr : homeAbbr,
      price,
      displayPrice: priceToDisplayCents(price),
      isAway: matchesAway,
    };
  });

  const awayOpt = mapped.find((m) => m.isAway) ?? mapped[0];
  const homeOpt = mapped.find((m) => !m.isAway) ?? mapped[1];
  return [awayOpt, homeOpt]
    .filter(Boolean)
    .map(({ label, price, displayPrice }) => ({ label, price, displayPrice }));
}

// Build spread options in [away, home] order
// e.g. "Spread: Toronto Blue Jays (-1.5)" → away="LAA +1.5", home="TOR -1.5"
function buildSpreadOptions(
  market: PolymarketMarket,
  awayAbbr: string,
  homeAbbr: string,
  awayName: string,
): OddsOption[] {
  const { outcomes, prices } = parseOutcomes(market);
  const q = market.question;

  const lineMatch = q.match(/[+-]?(\d+\.5)/);
  const lineMag = lineMatch ? parseFloat(lineMatch[1]) : null;
  // Which team is named in the spread title? That team has the stated line sign.
  const titleFavorsAway = teamMatchesTitle(awayName, awayAbbr, awayAbbr, q);
  const favLine = lineMag !== null ? (q.includes(`-${lineMag}`) ? -lineMag : lineMag) : null;

  const mapped = outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const outcomeMatchesAway =
      teamsMatch(outcome, awayName) ||
      outcome.toLowerCase().includes(awayAbbr.toLowerCase());
    const abbr = outcomeMatchesAway ? awayAbbr : homeAbbr;

    let label = abbr;
    if (favLine !== null) {
      const line = titleFavorsAway
        ? outcomeMatchesAway ? favLine : -favLine
        : outcomeMatchesAway ? -favLine : favLine;
      label = `${abbr} ${signedLine(line)}`;
    }

    return { label, price, displayPrice: priceToDisplayCents(price), isAway: outcomeMatchesAway };
  });

  const awayOpt = mapped.find((m) => m.isAway) ?? mapped[0];
  const homeOpt = mapped.find((m) => !m.isAway) ?? mapped[1];
  return [awayOpt, homeOpt]
    .filter(Boolean)
    .map(({ label, price, displayPrice }) => ({ label, price, displayPrice }));
}

// Build total (O/U) options: Over first, Under second
function buildTotalOptions(market: PolymarketMarket): OddsOption[] {
  const { outcomes, prices } = parseOutcomes(market);
  const q = market.question;
  const lineMatch = q.match(/(\d+\.?\d*)/g);
  const line = lineMatch ? lineMatch[lineMatch.length - 1] : null;

  return outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const isOver = outcome.toLowerCase() === "over" || outcome.toLowerCase() === "yes";
    const label = line ? `${isOver ? "O" : "U"} ${line}` : outcome;
    return { label, price, displayPrice: priceToDisplayCents(price) };
  });
}

// Check whether a Polymarket event matches an ESPN game (order-independent)
function gameMatchesEvent(game: ArbGame, event: PolymarketEvent): boolean {
  const title = event.title;

  const awayMatches = teamMatchesTitle(
    game.awayTeam.name,
    game.awayTeam.shortName,
    game.awayTeam.abbreviation,
    title
  );
  const homeMatches = teamMatchesTitle(
    game.homeTeam.name,
    game.homeTeam.shortName,
    game.homeTeam.abbreviation,
    title
  );

  return awayMatches && homeMatches;
}

// A market is settled when any price is within 1% of 0 or 100%
function isSettledMarket(prices: (number | null)[]): boolean {
  const valid = prices.filter((p): p is number => p !== null);
  if (valid.length === 0) return false;
  return valid.some((p) => p >= 0.99 || p <= 0.01);
}

function hasRealPrices(prices: (number | null)[]): boolean {
  return prices.some((p) => p !== null && p > 0.01 && p < 0.99);
}

function eventHasLivePrices(event: PolymarketEvent): boolean {
  return (event.markets ?? []).some((m) => {
    const { prices } = parseOutcomes(m);
    return hasRealPrices(prices);
  });
}

export async function fetchPolymarketData(
  games: MLBGame[],
): Promise<Map<string, GameMarket>> {
  const events = await fetchMLBEvents();
  const marketMap = new Map<string, GameMarket>();

  for (const game of games) {
    // Find all events matching this game (may have multiple per series)
    const matchedEvents = events.filter((ev) => gameMatchesEvent(game, ev));

    if (matchedEvents.length === 0) continue;

    // Pick the event whose date window best matches the game date
    const gameDate = game.date; // YYYY-MM-DD from ESPN
    const matchedEvent = pickBestEvent(matchedEvents, gameDate);
    if (!matchedEvent) continue;

    const gameMarket: GameMarket = {
      moneyline: [],
      spread: [],
      total: [],
      volume: formatVolume(matchedEvent.volume),
    };

    for (const market of matchedEvent.markets || []) {
      const type = classifyMarket(market);
      if (!type) continue;

      const { prices } = parseOutcomes(market);

      // Skip settled markets
      if (isSettledMarket(prices)) continue;

      const hasPrices = hasRealPrices(prices);

      if (type === "moneyline") {
        if (gameMarket.moneyline.length === 0 || hasPrices) {
          gameMarket.moneyline = buildMoneylineOptions(
            market,
            game.awayTeam.abbreviation,
            game.homeTeam.abbreviation,
            game.awayTeam.name,
          );
        }
      } else if (type === "spread") {
        if (gameMarket.spread.length === 0 || hasPrices) {
          gameMarket.spread = buildSpreadOptions(
            market,
            game.awayTeam.abbreviation,
            game.homeTeam.abbreviation,
            game.awayTeam.name,
          );
        }
      } else if (type === "total") {
        if (gameMarket.total.length === 0 || hasPrices) {
          gameMarket.total = buildTotalOptions(market);
        }
      }
    }

    marketMap.set(game.id, gameMarket);
  }

  return marketMap;
}

// ── Arbitrage support: every total line per game (not just the main line) ─────

// Returns ALL total lines Polymarket offers for each game, keyed by ESPN gameId,
// so the arb matching engine can pair the same line across venues. A single Polymarket
// event mixes full-game AND F5 total markets together (verified live — same event object
// carries both "O/U 8.5" and "1st 5 Innings O/U 8.5"), so `segment` filters to exactly one
// — without this, full-game and F5 lines would be silently merged by number alone.
export async function fetchPolymarketTotalsByGame(
  games: ArbGame[],
  tag: string = "mlb",
  segment: MarketSegment = "full_game"
): Promise<Map<string, VenueTotalLine[]>> {
  const result = new Map<string, VenueTotalLine[]>();
  if (!games.length) return result;

  const events = await fetchMLBEvents(tag);

  for (const game of games) {
    const matchedEvents = events.filter((ev) => gameMatchesEvent(game, ev));
    if (matchedEvents.length === 0) continue;
    const event = pickBestEvent(matchedEvents, game.date);
    if (!event) continue;

    const byLine = new Map<
      number,
      { overCents: number; underCents: number; overLiquidityUsd: number; underLiquidityUsd: number; id: string; overTokenId?: string; underTokenId?: string }
    >();
    for (const market of event.markets ?? []) {
      if (classifyMarket(market) !== "total") continue;
      if (classifyMarketSegment(market.question) !== segment) continue;
      const { outcomes, prices, tokenIds } = parseOutcomes(market);
      if (isSettledMarket(prices)) continue;

      const lineMatch = market.question.match(/(\d+\.?\d*)/g);
      const line = lineMatch ? parseFloat(lineMatch[lineMatch.length - 1]) : null;
      if (line == null || Number.isNaN(line)) continue;

      // Mid prices per outcome (fallback if bid/ask are absent).
      let overMid: number | null = null;
      let underMid: number | null = null;
      outcomes.forEach((o, i) => {
        const label = o.toLowerCase();
        if (label === "over" || label === "yes") overMid = prices[i];
        else if (label === "under" || label === "no") underMid = prices[i];
      });

      // Executable buy costs from top-of-book. Gamma's bestBid/bestAsk are for the
      // first-outcome token; the complement's ask = 1 - that token's bid.
      const firstIsOver = ["over", "yes"].includes((outcomes[0] ?? "").toLowerCase());
      const bestBid = typeof market.bestBid === "number" ? market.bestBid : null;
      const bestAsk = typeof market.bestAsk === "number" ? market.bestAsk : null;

      let overAsk: number | null;
      let underAsk: number | null;
      if (bestBid != null && bestAsk != null) {
        if (firstIsOver) {
          overAsk = bestAsk;
          underAsk = 1 - bestBid;
        } else {
          underAsk = bestAsk;
          overAsk = 1 - bestBid;
        }
      } else {
        overAsk = overMid;
        underAsk = underMid != null ? underMid : overMid != null ? 1 - overMid : null;
      }

      if (overAsk == null || underAsk == null) continue;
      if (overAsk <= 0 || overAsk >= 1) continue; // no ask liquidity / settled

      // Book liquidity ($) for this line, shared by both outcomes.
      const liq = typeof market.liquidityNum === "number" ? market.liquidityNum : 0;

      if (!byLine.has(line)) {
        byLine.set(line, {
          overCents: Math.round(overAsk * 100),
          underCents: Math.round(underAsk * 100),
          overLiquidityUsd: liq,
          underLiquidityUsd: liq,
          id: market.id,
          overTokenId: tokenIdFor(outcomes, tokenIds, (l) => l === "over" || l === "yes"),
          underTokenId: tokenIdFor(outcomes, tokenIds, (l) => l === "under" || l === "no"),
        });
      }
    }

    if (byLine.size === 0) continue;
    const sourceStartTime = polymarketGameDate(event) ?? game.date;
    result.set(
      game.id,
      [...byLine.entries()].map(([line, q]) => ({
        line,
        overCents: q.overCents,
        underCents: q.underCents,
        overLiquidityUsd: q.overLiquidityUsd,
        underLiquidityUsd: q.underLiquidityUsd,
        marketId: q.id,
        overTokenId: q.overTokenId,
        underTokenId: q.underTokenId,
        sourceStartTime,
      }))
    );
  }

  return result;
}

// Polymarket MLB moneyline per game (home/away buy costs at the ask).
export async function fetchPolymarketMoneylineByGame(
  games: ArbGame[],
  tag: string = "mlb"
): Promise<Map<string, VenueTwoWay>> {
  const result = new Map<string, VenueTwoWay>();
  if (!games.length) return result;

  const events = await fetchMLBEvents(tag);

  for (const game of games) {
    const matched = events.filter((ev) => gameMatchesEvent(game, ev));
    if (matched.length === 0) continue;
    const event = pickBestEvent(matched, game.date);
    if (!event) continue;

    const ml = (event.markets ?? []).find((m) => classifyMarket(m) === "moneyline");
    if (!ml) continue;
    const { outcomes, prices, tokenIds } = parseOutcomes(ml);
    if (outcomes.length < 2 || isSettledMarket(prices)) continue;

    // Resolve both native labels independently. Never infer an unknown token as the
    // opposite team: a bad inference here produces two same-team legs across venues.
    const teamOrder = resolveTwoWayTeamOrder(outcomes, game.awayTeam, game.homeTeam);
    if (!teamOrder) continue;
    const outcome0IsAway = teamOrder === "away_home";
    const awayTokenId = outcome0IsAway ? tokenIds[0] ?? undefined : tokenIds[1] ?? undefined;
    const homeTokenId = outcome0IsAway ? tokenIds[1] ?? undefined : tokenIds[0] ?? undefined;

    const bestBid = typeof ml.bestBid === "number" ? ml.bestBid : null;
    const bestAsk = typeof ml.bestAsk === "number" ? ml.bestAsk : null;

    let awayAsk: number | null;
    let homeAsk: number | null;
    if (bestBid != null && bestAsk != null) {
      const ask0 = bestAsk;
      const ask1 = 1 - bestBid;
      awayAsk = outcome0IsAway ? ask0 : ask1;
      homeAsk = outcome0IsAway ? ask1 : ask0;
    } else {
      const p0 = prices[0];
      const p1 = prices[1];
      if (p0 == null || p1 == null) continue;
      awayAsk = outcome0IsAway ? p0 : p1;
      homeAsk = outcome0IsAway ? p1 : p0;
    }

    if (awayAsk == null || homeAsk == null) continue;
    if (awayAsk <= 0 || awayAsk >= 1 || homeAsk <= 0 || homeAsk >= 1) continue;

    const liq = typeof ml.liquidityNum === "number" ? ml.liquidityNum : 0;
    result.set(game.id, {
      homeCents: Math.round(homeAsk * 100),
      awayCents: Math.round(awayAsk * 100),
      homeLiquidityUsd: liq,
      awayLiquidityUsd: liq,
      marketId: ml.id,
      homeTokenId,
      awayTokenId,
      sourceStartTime: polymarketGameDate(event) ?? game.date,
    });
  }

  return result;
}

// Polymarket soccer 1X2 / tennis winner. Polymarket's CLOB markets are binary, so a
// soccer match is THREE Yes/No markets in one event ("Will {home} win", "…end in a draw",
// "Will {away} win") and tennis is TWO ("Will {player} win"). Backing an outcome = buying
// YES of its market, so the cost is that market's YES ask (bestAsk, which Gamma quotes for
// the first outcome = "Yes"). `threeWay` adds the draw leg (dropped if the draw market is
// missing). Validated live: MLS games priced ~100-102¢ across the three markets.
export async function fetchPolymarketWinnerByGame(
  games: ArbGame[],
  tag: string,
  threeWay = false
): Promise<Map<string, VenueTwoWay>> {
  const result = new Map<string, VenueTwoWay>();
  if (!games.length) return result;
  const events = await fetchMLBEvents(tag);

  // YES ask for a binary market: prefer the live bestAsk, else the first outcome price.
  const yesAsk = (m: PolymarketMarket): number | null => {
    if (typeof m.bestAsk === "number" && m.bestAsk > 0 && m.bestAsk < 1) return m.bestAsk;
    const { prices } = parseOutcomes(m);
    const p = prices[0];
    return p != null && p > 0 && p < 1 ? p : null;
  };
  const yesToken = (m: PolymarketMarket): string | undefined => parseOutcomes(m).tokenIds[0] ?? undefined;
  const liqOf = (m: PolymarketMarket): number => (typeof m.liquidityNum === "number" ? m.liquidityNum : 0);
  const namesTeam = (q: string, t: { name: string; shortName: string; abbreviation: string }) =>
    teamMatchesTitle(t.name, t.shortName, t.abbreviation, q);

  for (const game of games) {
    const matchedEvents = events.filter((ev) => gameMatchesEvent(game, ev));
    if (matchedEvents.length === 0) continue;
    const event = pickBestEvent(matchedEvents, game.date);
    if (!event) continue;
    const markets = event.markets ?? [];
    if (!markets.length) continue;

    // The per-outcome "win" markets name exactly one team; the draw market says draw/tie.
    const homeM = markets.find((m) => /\bwin\b/i.test(m.question) && namesTeam(m.question, game.homeTeam) && !namesTeam(m.question, game.awayTeam));
    const awayM = markets.find((m) => /\bwin\b/i.test(m.question) && namesTeam(m.question, game.awayTeam) && !namesTeam(m.question, game.homeTeam));
    if (!homeM || !awayM) continue;
    const homeAsk = yesAsk(homeM);
    const awayAsk = yesAsk(awayM);
    if (homeAsk == null || awayAsk == null) continue;

    let drawFields: Partial<VenueTwoWay> = {};
    if (threeWay) {
      const drawM = markets.find((m) => /\b(draw|tie)\b/i.test(m.question));
      const drawAsk = drawM ? yesAsk(drawM) : null;
      if (drawM == null || drawAsk == null) continue; // incomplete 1X2 → skip
      drawFields = { drawCents: Math.round(drawAsk * 100), drawLiquidityUsd: liqOf(drawM), drawTokenId: yesToken(drawM) };
    }

    result.set(game.id, {
      homeCents: Math.round(homeAsk * 100),
      awayCents: Math.round(awayAsk * 100),
      homeLiquidityUsd: liqOf(homeM),
      awayLiquidityUsd: liqOf(awayM),
      marketId: homeM.id,
      homeTokenId: yesToken(homeM),
      awayTokenId: yesToken(awayM),
      sourceStartTime: polymarketGameDate(event) ?? game.date,
      ...drawFields,
    });
  }
  return result;
}

// Polymarket F5 (first-5-innings) winner: same "3 independent binary markets" shape as
// fetchKalshiF5MoneylineByGame — one market per team ("{Team} winning after 5 innings?")
// plus a tie market ("{A} vs. {B}: Tied after 5 innings?"). A tie after 5 is possible, so
// the tie leg is always attempted (unlike fetchPolymarketWinnerByGame's optional threeWay,
// F5 has no 2-outcome variant). Dedicated question regex — distinct from
// fetchPolymarketWinnerByGame's "\bwin\b" (which does not match "winning") so it can't
// collide with that function's soccer/tennis usage.
export async function fetchPolymarketF5WinnerByGame(
  games: ArbGame[],
  tag: string = "mlb"
): Promise<Map<string, VenueTwoWay>> {
  const result = new Map<string, VenueTwoWay>();
  if (!games.length) return result;
  const events = await fetchMLBEvents(tag);

  const yesAsk = (m: PolymarketMarket): number | null => {
    if (typeof m.bestAsk === "number" && m.bestAsk > 0 && m.bestAsk < 1) return m.bestAsk;
    const { prices } = parseOutcomes(m);
    const p = prices[0];
    return p != null && p > 0 && p < 1 ? p : null;
  };
  const yesToken = (m: PolymarketMarket): string | undefined => parseOutcomes(m).tokenIds[0] ?? undefined;
  const liqOf = (m: PolymarketMarket): number => (typeof m.liquidityNum === "number" ? m.liquidityNum : 0);
  const namesTeam = (q: string, t: { name: string; shortName: string; abbreviation: string }) =>
    teamMatchesTitle(t.name, t.shortName, t.abbreviation, q);

  for (const game of games) {
    const matchedEvents = events.filter((ev) => gameMatchesEvent(game, ev));
    if (matchedEvents.length === 0) continue;
    const event = pickBestEvent(matchedEvents, game.date);
    if (!event) continue;
    const markets = event.markets ?? [];
    if (!markets.length) continue;

    const homeM = markets.find((m) => /winning after 5 innings/i.test(m.question) && namesTeam(m.question, game.homeTeam) && !namesTeam(m.question, game.awayTeam));
    const awayM = markets.find((m) => /winning after 5 innings/i.test(m.question) && namesTeam(m.question, game.awayTeam) && !namesTeam(m.question, game.homeTeam));
    if (!homeM || !awayM) continue;
    const homeAsk = yesAsk(homeM);
    const awayAsk = yesAsk(awayM);
    if (homeAsk == null || awayAsk == null) continue;

    const tieM = markets.find((m) => /tied after 5 innings/i.test(m.question));
    const tieAsk = tieM ? yesAsk(tieM) : null;
    const drawFields: Partial<VenueTwoWay> =
      tieM && tieAsk != null ? { drawCents: Math.round(tieAsk * 100), drawLiquidityUsd: liqOf(tieM), drawTokenId: yesToken(tieM) } : {};

    result.set(game.id, {
      homeCents: Math.round(homeAsk * 100),
      awayCents: Math.round(awayAsk * 100),
      homeLiquidityUsd: liqOf(homeM),
      awayLiquidityUsd: liqOf(awayM),
      marketId: homeM.id,
      homeTokenId: yesToken(homeM),
      awayTokenId: yesToken(awayM),
      sourceStartTime: polymarketGameDate(event) ?? game.date,
      ...drawFields,
    });
  }
  return result;
}

// Polymarket MLB runline (spread). Question names one team with a sign, e.g.
// "Spread: Toronto Blue Jays (-1.5)". Maps to home/away cover + signed home line.
// `segment` disambiguates full-game vs F5 spread markets, which share the same event
// object (see fetchPolymarketTotalsByGame).
export async function fetchPolymarketSpreadByGame(
  games: ArbGame[],
  tag: string = "mlb",
  segment: MarketSegment = "full_game"
): Promise<Map<string, VenueSpread>> {
  const result = new Map<string, VenueSpread>();
  if (!games.length) return result;

  const events = await fetchMLBEvents(tag);

  for (const game of games) {
    const matched = events.filter((ev) => gameMatchesEvent(game, ev));
    if (matched.length === 0) continue;
    const event = pickBestEvent(matched, game.date);
    if (!event) continue;

    const sp = (event.markets ?? []).find((m) => classifyMarket(m) === "spread" && classifyMarketSegment(m.question) === segment);
    if (!sp) continue;
    const { outcomes, prices, tokenIds } = parseOutcomes(sp);
    if (outcomes.length < 2 || isSettledMarket(prices)) continue;

    const q = sp.question;
    const lineMatch = q.match(/(\d+\.5)/);
    const lineMag = lineMatch ? parseFloat(lineMatch[1]) : 1.5;
    const favLine = q.includes(`-${lineMag}`) ? -lineMag : lineMag;
    const titleFavorsAway = teamMatchesTitle(game.awayTeam.name, game.awayTeam.shortName, game.awayTeam.abbreviation, q);
    const homeSignedLine = titleFavorsAway ? -favLine : favLine;

    const teamOrder = resolveTwoWayTeamOrder(outcomes, game.awayTeam, game.homeTeam);
    if (!teamOrder) continue;
    const outcome0IsHome = teamOrder === "home_away";
    const homeTokenId = outcome0IsHome ? tokenIds[0] ?? undefined : tokenIds[1] ?? undefined;
    const awayTokenId = outcome0IsHome ? tokenIds[1] ?? undefined : tokenIds[0] ?? undefined;

    const bestBid = typeof sp.bestBid === "number" ? sp.bestBid : null;
    const bestAsk = typeof sp.bestAsk === "number" ? sp.bestAsk : null;

    let homeAsk: number | null;
    let awayAsk: number | null;
    if (bestBid != null && bestAsk != null) {
      const ask0 = bestAsk;
      const ask1 = 1 - bestBid;
      homeAsk = outcome0IsHome ? ask0 : ask1;
      awayAsk = outcome0IsHome ? ask1 : ask0;
    } else {
      const p0 = prices[0];
      const p1 = prices[1];
      if (p0 == null || p1 == null) continue;
      homeAsk = outcome0IsHome ? p0 : p1;
      awayAsk = outcome0IsHome ? p1 : p0;
    }

    if (homeAsk == null || awayAsk == null) continue;
    if (homeAsk <= 0 || homeAsk >= 1 || awayAsk <= 0 || awayAsk >= 1) continue;

    const liq = typeof sp.liquidityNum === "number" ? sp.liquidityNum : 0;
    result.set(game.id, {
      homeCents: Math.round(homeAsk * 100),
      awayCents: Math.round(awayAsk * 100),
      homeLiquidityUsd: liq,
      awayLiquidityUsd: liq,
      homeSignedLine,
      marketId: sp.id,
      homeTokenId,
      awayTokenId,
      sourceStartTime: polymarketGameDate(event) ?? game.date,
    });
  }

  return result;
}

