// Ingestion: for each configured sport, fetch games + Kalshi/Polymarket/SX.bet
// markets (totals / moneyline / spread), normalize into the shared NormalizedMarket
// model, and persist. The matching + arb engines key events by sport:league:teams,
// so MLB and WNBA share one pipeline without cross-matching.

import {
  fetchKalshiMoneylineByGame,
  fetchKalshiSpreadByGame,
  fetchKalshiTotalsByGame,
  type VenueSpread,
  type VenueTotalLine,
  type VenueTwoWay,
} from "@/lib/kalshi";
import {
  fetchPolymarketMoneylineByGame,
  fetchPolymarketSpreadByGame,
  fetchPolymarketTotalsByGame,
  fetchPolymarketWinnerByGame,
} from "@/lib/polymarket";
import { fetchPolymarketUsMLBMarkets, type PolymarketUsMarkets } from "@/lib/polymarketUs";
import { polymarketRegion } from "@/lib/polymarketRegion";
import { fetchPredictFunMoneylineByGame } from "@/lib/predictFun";
import { fetchCloudbetMoneylineByGame } from "@/lib/cloudbet";
import { fetchSxBetMLBMarkets, fetchSxBetMoneylineByGame, type SxBetMarkets } from "@/lib/sxbet";
import type { MarketType, NormalizedMarket, Outcome, Sport, VenueId } from "@/types/arbitrage";
import { decimalOddsFromCents, impliedProbFromCents } from "./arbMath";
import { buildEventKey } from "./matching";
import { getMarkets, saveMarkets, setRunning } from "./marketStore";
import { SPORTS, type ArbGame, type SportConfig } from "./sports";

// Narrows a targeted pre-trade refresh to only the venues + market type an opportunity
// actually needs, instead of re-fetching every venue × every market type for the game
// (the dominant placement latency: a 2-venue moneyline arb only needs 2 venues × 1 type).
export type IngestScope = { venues?: Set<VenueId>; marketTypes?: Set<MarketType> };
function scopeAllows(scope: IngestScope | undefined, venue: VenueId, marketType: MarketType): boolean {
  if (!scope) return true;
  if (scope.venues && !scope.venues.has(venue)) return false;
  if (scope.marketTypes && !scope.marketTypes.has(marketType)) return false;
  return true;
}
function scopeAllowsVenue(scope: IngestScope | undefined, venue: VenueId): boolean {
  return !scope?.venues || scope.venues.has(venue);
}
// opportunityId = `${eventKey}:${marketType}:${line}`; eventKey has colons but marketType
// never does, so the market type is the second-to-last colon segment.
const MARKET_TYPES: MarketType[] = ["moneyline", "total", "spread"];
function opportunityMarketType(opportunityId: string): MarketType | null {
  const seg = opportunityId.split(":").at(-2);
  return MARKET_TYPES.find((t) => t === seg) ?? null;
}

const EMPTY_SX: SxBetMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };
const EMPTY_PM: PolymarketUsMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };
const emptyTotals = () => new Map<string, VenueTotalLine[]>();
const emptyTwoWay = () => new Map<string, VenueTwoWay>();
const emptySpread = () => new Map<string, VenueSpread>();

type Timed<T> = { data: T; fetchedAt: string };

async function withFetchedAt<T>(promise: Promise<T>, fallback: T): Promise<Timed<T>> {
  try {
    const data = await promise;
    return { data, fetchedAt: new Date().toISOString() };
  } catch {
    return { data: fallback, fetchedAt: new Date().toISOString() };
  }
}

async function fetchPolymarketConfiguredMoneyline(
  games: ArbGame[],
  tag: string,
  sport: Sport
): Promise<Map<string, VenueTwoWay>> {
  if (sport === "soccer") return fetchPolymarketWinnerByGame(games, tag, true);
  if (sport !== "tennis") return fetchPolymarketMoneylineByGame(games, tag, sport);

  const [winner, legacy] = await Promise.allSettled([
    fetchPolymarketWinnerByGame(games, tag, false),
    fetchPolymarketMoneylineByGame(games, tag, sport),
  ]);
  const out = new Map<string, VenueTwoWay>();
  if (legacy.status === "fulfilled") {
    for (const [gameId, quote] of legacy.value) out.set(gameId, quote);
  }
  if (winner.status === "fulfilled") {
    for (const [gameId, quote] of winner.value) out.set(gameId, quote);
  }
  return out;
}

// The venue-native side identifier a live order needs for a given outcome:
//   • Kalshi         → "yes" | "no"
//   • Polymarket intl→ the ERC-1155 CLOB token id for that outcome
//   • Polymarket US  → "yes" | "no" (long/Over ⇒ YES, short/Under ⇒ NO); marketSlug on nativeMarketId
//   • SX.bet         → "one" | "two" (isTakerBettingOutcomeOne)
// Undefined when the venue hasn't supplied the id (read-only rows still ingest fine).
function nativeSideFor(
  venueId: VenueId,
  ids: { kalshiYesNo: "yes" | "no"; polyTokenId?: string; sxIsOne?: boolean }
): string | undefined {
  if (venueId === "kalshi") return ids.kalshiYesNo;
  if (venueId === "polymarket") return polymarketRegion() === "us" ? ids.kalshiYesNo : ids.polyTokenId;
  if (venueId === "predictfun") return ids.polyTokenId; // on-chain outcome token id
  if (venueId === "cloudbet") return ids.polyTokenId; // CloudBet market URL (marketKey/outcome)
  if (venueId === "sxbet") {
    // Dynamic SX 1X2 soccer markets are modeled as separate "X vs Not X" markets.
    // The per-outcome hash rides in polyTokenId, and backing that result is always
    // outcome ONE. Fixed two-way SX markets use the explicit outcome-one mapping.
    if (ids.polyTokenId) return "one";
    return ids.sxIsOne === undefined ? undefined : ids.sxIsOne ? "one" : "two";
  }
  return undefined;
}

function normalizeVenueTotals(
  venueId: VenueId,
  game: ArbGame,
  lines: VenueTotalLine[] | undefined,
  sport: Sport,
  league: string,
  now: string
): NormalizedMarket[] {
  if (!lines?.length) return [];
  const teams: [string, string] = [game.awayTeam.shortName, game.homeTeam.shortName];
  const rows: NormalizedMarket[] = [];
  for (const l of lines) {
    for (const [outcome, priceCents, liqUsd, tokenId, sxIsOne] of [
      ["over", l.overCents, l.overLiquidityUsd, l.overTokenId, l.overIsOutcomeOne] as const,
      ["under", l.underCents, l.underLiquidityUsd, l.underTokenId, l.overIsOutcomeOne === undefined ? undefined : !l.overIsOutcomeOne] as const,
    ]) {
      if (priceCents <= 0 || priceCents >= 100) continue;
      const liquidityUsd = Number.isFinite(liqUsd) ? Math.round(liqUsd) : 0;
      rows.push({
        venueId,
        marketId: `${venueId}:${game.id}:total:${l.line}:${outcome}`,
        // Kalshi totals: buying OVER = buy YES, UNDER = buy NO, on the line's ticker.
        nativeMarketId: l.marketId,
        nativeSide: nativeSideFor(venueId, { kalshiYesNo: outcome === "over" ? "yes" : "no", polyTokenId: tokenId, sxIsOne }),
        sourceStartTime: l.sourceStartTime,
        sport,
        league,
        startTime: game.date,
        teams,
        marketType: "total",
        line: l.line,
        outcome,
        priceCents,
        decimalOdds: decimalOddsFromCents(priceCents),
        impliedProbability: impliedProbFromCents(priceCents),
        depth: priceCents > 0 ? Math.floor(liquidityUsd / (priceCents / 100)) : 0,
        liquidityUsd,
        live: true,
        status: "open",
        lastUpdated: now,
      });
    }
  }
  return rows;
}

function normalizeVenueTwoWay(
  venueId: VenueId,
  game: ArbGame,
  q: (VenueTwoWay & { homeSignedLine?: number }) | undefined,
  marketType: "moneyline" | "spread",
  sport: Sport,
  league: string,
  now: string
): NormalizedMarket[] {
  if (!q) return [];
  const teams: [string, string] = [game.awayTeam.shortName, game.homeTeam.shortName];
  const line = marketType === "spread" ? q.homeSignedLine ?? null : null;
  const lineKey = marketType === "spread" ? String(q.homeSignedLine ?? 0) : "0";
  const rows: NormalizedMarket[] = [];
  const sides: Array<readonly [Outcome, number | undefined, number | undefined, string | undefined, boolean | undefined]> = [
    ["home", q.homeCents, q.homeLiquidityUsd, q.homeTokenId, q.homeIsOutcomeOne],
    ["away", q.awayCents, q.awayLiquidityUsd, q.awayTokenId, q.homeIsOutcomeOne === undefined ? undefined : !q.homeIsOutcomeOne],
  ];
  // Soccer 1X2: a third leg when the venue supplied a draw price (moneyline only).
  if (marketType === "moneyline" && typeof q.drawCents === "number") {
    sides.push(["draw", q.drawCents, q.drawLiquidityUsd, q.drawTokenId, undefined]);
  }
  for (const [outcome, priceCents, liqUsd, tokenId, sxIsOne] of sides) {
    if (priceCents == null || priceCents <= 0 || priceCents >= 100) continue;
    const liquidityUsd = typeof liqUsd === "number" && Number.isFinite(liqUsd) ? Math.round(liqUsd) : 0;
    rows.push({
      venueId,
      marketId: `${venueId}:${game.id}:${marketType}:${lineKey}:${outcome}`,
      // Kalshi two-way: buy YES on the team the market's YES side represents, else NO.
      nativeMarketId: venueId === "sxbet" && tokenId ? tokenId : q.marketId,
      nativeSide: nativeSideFor(venueId, {
        kalshiYesNo: q.yesSide && outcome === q.yesSide ? "yes" : "no",
        polyTokenId: tokenId,
        sxIsOne,
      }),
      sourceStartTime: q.sourceStartTime,
      sport,
      league,
      startTime: game.date,
      teams,
      marketType,
      line,
      outcome: outcome as Outcome,
      priceCents,
      decimalOdds: decimalOddsFromCents(priceCents),
      impliedProbability: impliedProbFromCents(priceCents),
      depth: priceCents > 0 ? Math.floor(liquidityUsd / (priceCents / 100)) : 0,
      liquidityUsd,
      live: true,
      status: "open",
      lastUpdated: now,
    });
  }
  return rows;
}

export type IngestResult = {
  date: string;
  gameCount: number;
  markets: NormalizedMarket[];
  venueCounts: Record<VenueId, number>;
};

async function ingestSportMarkets(
  cfg: SportConfig,
  games: ArbGame[],
  scope?: IngestScope
): Promise<{ markets: NormalizedMarket[]; venueCounts: Record<VenueId, number> }> {
  const markets: NormalizedMarket[] = [];
  const venueCounts: Record<VenueId, number> = { kalshi: 0, polymarket: 0, sxbet: 0, predictfun: 0, cloudbet: 0 };
  if (!games.length) return { markets, venueCounts };

  const allow = (v: VenueId, t: MarketType) => scopeAllows(scope, v, t);
  const allowV = (v: VenueId) => scopeAllowsVenue(scope, v);
  const freshEmptyTotals = () => ({ data: emptyTotals(), fetchedAt: new Date().toISOString() });
  const freshEmptyTwoWay = () => ({ data: emptyTwoWay(), fetchedAt: new Date().toISOString() });
  const freshEmptySpread = () => ({ data: emptySpread(), fetchedAt: new Date().toISOString() });

  // Fetch every venue for this sport CONCURRENTLY. These used to be awaited one after another
  // (Kalshi → Polymarket → SX → SX-dynamic → predict.fun → cloudbet), so a cycle took the SUM
  // of every venue's latency and the first-fetched quotes were already tens of seconds stale by
  // the time the last venue returned — the main reason detected arbs vanished at execution.
  // Running them together makes a cycle take the MAX venue latency instead. Each fetch is
  // wrapped in withFetchedAt (never rejects), so one slow/failing venue can't break the others.
  const kalshiP = Promise.all([
    cfg.kalshi && cfg.markets.totals && allow("kalshi", "total") ? withFetchedAt(fetchKalshiTotalsByGame(games, cfg.kalshi.total), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
    cfg.kalshi && cfg.markets.moneyline && allow("kalshi", "moneyline") ? withFetchedAt(fetchKalshiMoneylineByGame(games, cfg.kalshi.game), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay()),
    cfg.kalshi && cfg.markets.spread && allow("kalshi", "spread") ? withFetchedAt(fetchKalshiSpreadByGame(games, cfg.kalshi.spread, cfg.spreadFixedLine), emptySpread()) : Promise.resolve(freshEmptySpread()),
  ]);

  const polyP: Promise<{ pTot: Timed<Map<string, VenueTotalLine[]>>; pML: Timed<Map<string, VenueTwoWay>>; pSp: Timed<Map<string, VenueSpread>> }> = (async () => {
    if (!(cfg.polyTag && allowV("polymarket"))) {
      return { pTot: freshEmptyTotals(), pML: freshEmptyTwoWay(), pSp: freshEmptySpread() };
    }
    if ((cfg.markets.totals || cfg.markets.spread) && polymarketRegion() === "us") {
      const pm = await withFetchedAt(fetchPolymarketUsMLBMarkets(games), EMPTY_PM);
      return {
        pTot: { data: pm.data.totals, fetchedAt: pm.fetchedAt },
        pML: { data: pm.data.moneyline, fetchedAt: pm.fetchedAt },
        pSp: { data: pm.data.spread, fetchedAt: pm.fetchedAt },
      };
    }
    const tag = cfg.polyTag;
    const [pTot, pML, pSp] = await Promise.all([
      cfg.markets.totals && allow("polymarket", "total") ? withFetchedAt(fetchPolymarketTotalsByGame(games, tag), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
      cfg.markets.moneyline && allow("polymarket", "moneyline")
        ? withFetchedAt(fetchPolymarketConfiguredMoneyline(games, tag, cfg.sport), emptyTwoWay())
        : Promise.resolve(freshEmptyTwoWay()),
      cfg.markets.spread && allow("polymarket", "spread") ? withFetchedAt(fetchPolymarketSpreadByGame(games, tag), emptySpread()) : Promise.resolve(freshEmptySpread()),
    ]);
    return { pTot, pML, pSp };
  })();

  const sxP = cfg.sxLeagueId != null && allowV("sxbet") ? withFetchedAt(fetchSxBetMLBMarkets(games, cfg.sxLeagueId), EMPTY_SX) : Promise.resolve({ data: EMPTY_SX, fetchedAt: new Date().toISOString() });
  const sxDynP = cfg.sxDynamic && allow("sxbet", "moneyline") ? withFetchedAt(fetchSxBetMoneylineByGame(games, cfg.sxDynamic), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay());
  const pfP = cfg.predictfun && allow("predictfun", "moneyline") ? withFetchedAt(fetchPredictFunMoneylineByGame(games), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay());
  const cbP = cfg.cloudbet && allow("cloudbet", "moneyline") ? withFetchedAt(fetchCloudbetMoneylineByGame(games, cfg.cloudbet), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay());

  const [[kTot, kML, kSp], poly, sx, sxDynML, pfML, cbML] = await Promise.all([kalshiP, polyP, sxP, sxDynP, pfP, cbP]);
  const { pTot, pML, pSp } = poly;

  for (const game of games) {
    const kRows = [
      ...normalizeVenueTotals("kalshi", game, kTot.data.get(game.id), cfg.sport, cfg.league, kTot.fetchedAt),
      ...normalizeVenueTwoWay("kalshi", game, kML.data.get(game.id), "moneyline", cfg.sport, cfg.league, kML.fetchedAt),
      ...normalizeVenueTwoWay("kalshi", game, kSp.data.get(game.id), "spread", cfg.sport, cfg.league, kSp.fetchedAt),
    ];
    const pRows = [
      ...normalizeVenueTotals("polymarket", game, pTot.data.get(game.id), cfg.sport, cfg.league, pTot.fetchedAt),
      ...normalizeVenueTwoWay("polymarket", game, pML.data.get(game.id), "moneyline", cfg.sport, cfg.league, pML.fetchedAt),
      ...normalizeVenueTwoWay("polymarket", game, pSp.data.get(game.id), "spread", cfg.sport, cfg.league, pSp.fetchedAt),
    ];
    const sxMoneyline = cfg.sxDynamic ? sxDynML.data.get(game.id) : sx.data.moneyline.get(game.id);
    const sxMoneylineAt = cfg.sxDynamic ? sxDynML.fetchedAt : sx.fetchedAt;
    const sRows = [
      ...normalizeVenueTotals("sxbet", game, sx.data.totals.get(game.id), cfg.sport, cfg.league, sx.fetchedAt),
      ...normalizeVenueTwoWay("sxbet", game, sxMoneyline, "moneyline", cfg.sport, cfg.league, sxMoneylineAt),
      ...normalizeVenueTwoWay("sxbet", game, sx.data.spread.get(game.id), "spread", cfg.sport, cfg.league, sx.fetchedAt),
    ];
    const pfRows = normalizeVenueTwoWay("predictfun", game, pfML.data.get(game.id), "moneyline", cfg.sport, cfg.league, pfML.fetchedAt);
    const cbRows = normalizeVenueTwoWay("cloudbet", game, cbML.data.get(game.id), "moneyline", cfg.sport, cfg.league, cbML.fetchedAt);
    venueCounts.kalshi += kRows.length;
    venueCounts.polymarket += pRows.length;
    venueCounts.sxbet += sRows.length;
    venueCounts.predictfun += pfRows.length;
    venueCounts.cloudbet += cbRows.length;
    markets.push(...kRows, ...pRows, ...sRows, ...pfRows, ...cbRows);
  }

  return { markets, venueCounts };
}

// Ingest all configured sports for a date. Public market reads — no credentials.
export async function ingestTotals(date: string): Promise<IngestResult> {
  const markets: NormalizedMarket[] = [];
  const venueCounts: Record<VenueId, number> = { kalshi: 0, polymarket: 0, sxbet: 0, predictfun: 0, cloudbet: 0 };
  let gameCount = 0;

  await Promise.all(
    SPORTS.map(async (cfg) => {
      const games: ArbGame[] = await cfg.fetchGames(date).catch((e) => {
        console.error(`[arbitrage/ingest] ${cfg.league} games fetch failed:`, e);
        return [];
      });
      gameCount += games.length;
      if (!games.length) return;

      // Every configured venue begins fetching before any venue is awaited. There is no
      // scanner-level timeout: the complete snapshot is published only after all feeds
      // return, while individual adapters may still convert transport failures to empties.
      const ingested = await ingestSportMarkets(cfg, games);
      markets.push(...ingested.markets);
      for (const [venueId, count] of Object.entries(ingested.venueCounts)) {
        venueCounts[venueId] = (venueCounts[venueId] ?? 0) + count;
      }
    })
  );

  const mergedMarkets = await preserveMissingDynamicRows(date, markets);
  await saveMarkets(date, mergedMarkets);
  return { date, gameCount, markets: mergedMarkets, venueCounts };
}

function opportunityEventKey(opportunityId: string): string | null {
  const parts = opportunityId.split(":");
  if (parts.length < 3) return null;
  return parts.slice(0, -2).join(":");
}

function marketGameId(market: NormalizedMarket): string | null {
  const parts = market.marketId.split(":");
  return parts.length >= 2 ? parts[1] : null;
}

function dynamicSliceKey(m: NormalizedMarket): string | null {
  const gameId = marketGameId(m);
  if (!gameId) return null;
  return `${m.sport}:${m.league}:${m.venueId}:${gameId}:${m.marketType}`;
}

function rowIdentity(m: NormalizedMarket): string | null {
  const slice = dynamicSliceKey(m);
  return slice ? `${slice}:${m.line ?? "0"}:${m.outcome}` : null;
}

async function preserveMissingDynamicRows(date: string, next: NormalizedMarket[]): Promise<NormalizedMarket[]> {
  const current = await getMarkets(date);
  if (!current.length) return next;

  const dynamicVenueBySport = new Set(
    SPORTS.filter((cfg) => cfg.sxDynamic).map((cfg) => `${cfg.sport}:${cfg.league}:sxbet`)
  );
  const nextSlices = new Set(next.map(dynamicSliceKey).filter((k): k is string => Boolean(k)));
  const nextRows = new Set(next.map(rowIdentity).filter((k): k is string => Boolean(k)));
  const preserved = current.filter((m) => {
    const row = rowIdentity(m);
    const slice = dynamicSliceKey(m);
    if (!row || !slice || nextRows.has(row)) return false;
    if (!dynamicVenueBySport.has(`${m.sport}:${m.league}:${m.venueId}`)) return false;
    return !nextSlices.has(slice);
  });

  return preserved.length ? [...next, ...preserved] : next;
}

// Refresh only the game behind a live opportunity, then merge those rows back into
// the date cache. This keeps the pre-trade freshness check from waiting on every
// active sport/game/market in the scanner.
export async function refreshMarketsForOpportunity(
  date: string,
  opportunityId: string,
  legVenues?: VenueId[]
): Promise<NormalizedMarket[]> {
  const current = await getMarkets(date);
  const eventKey = opportunityEventKey(opportunityId);
  if (!eventKey) return current;

  const eventMarkets = current.filter((m) => buildEventKey(m) === eventKey);
  const seed = eventMarkets[0];
  const gameId = seed ? marketGameId(seed) : null;
  if (!seed || !gameId) return current;

  const cfg = SPORTS.find((s) => s.sport === seed.sport && s.league === seed.league);
  if (!cfg) return current;

  // Scope to the opportunity's market type and — when supplied — exactly the arb's leg
  // venues, so a slow non-leg venue never sits on the pre-trade critical path.
  const marketType = opportunityMarketType(opportunityId);
  const scopeVenues = legVenues?.length
    ? [...new Set(legVenues)]
    : marketType
      ? [...new Set(eventMarkets.filter((m) => m.marketType === marketType).map((m) => m.venueId))]
      : [];
  const scope: IngestScope | undefined = marketType
    ? { marketTypes: new Set([marketType]), venues: scopeVenues.length ? new Set(scopeVenues) : undefined }
    : undefined;

  const games = await cfg.fetchGames(date).catch((e) => {
    console.error(`[arbitrage/ingest] targeted ${cfg.league} games fetch failed:`, e);
    return [];
  });
  const game = games.find((g) => g.id === gameId);
  if (!game) return current;

  // Await every required leg venue with no scanner-level timeout. This refresh is already
  // scoped to one game/market, and live execution must not fall back to an older cache merely
  // because an arbitrary deadline elapsed.
  const fresh = await ingestSportMarkets(cfg, [game], scope);
  if (!fresh.markets.length) return current;

  // Replace only the (game, refreshed market type, refreshed venues) rows; keep everything
  // else so a scoped refresh never drops the venues/markets it didn't re-fetch.
  const refreshedTypes = scope?.marketTypes;
  const refreshedVenues = scope?.venues;
  const isRefreshedRow = (m: NormalizedMarket) =>
    m.sport === seed.sport &&
    m.league === seed.league &&
    marketGameId(m) === gameId &&
    (!refreshedTypes || refreshedTypes.has(m.marketType)) &&
    (!refreshedVenues || refreshedVenues.has(m.venueId));
  const merged = current.filter((m) => !isRefreshedRow(m));
  merged.push(...fresh.markets.filter((m) => !refreshedVenues || refreshedVenues.has(m.venueId)));
  await saveMarkets(date, merged);
  return merged;
}

// Fire-and-forget wrapper used by the run route; manages the running flag.
export async function runIngestion(date: string): Promise<IngestResult> {
  setRunning(date, true);
  try {
    const r = await ingestTotals(date);
    console.log(
      `[arbitrage/ingest] ${date}: ${r.gameCount} games, ` +
        `${r.venueCounts.kalshi} Kalshi + ${r.venueCounts.polymarket} Polymarket + ${r.venueCounts.sxbet} SX.bet + ${r.venueCounts.predictfun} predict.fun + ${r.venueCounts.cloudbet} CloudBet quotes`
    );
    return r;
  } catch (e) {
    console.error(`[arbitrage/ingest] ${date} failed:`, e);
    throw e;
  } finally {
    setRunning(date, false);
  }
}
