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
import { fetchCloudbetMoneylineByGame, fetchCloudbetSpreadByGame, fetchCloudbetTotalsByGame } from "@/lib/cloudbet";
import { fetchSxBetMLBMarkets, fetchSxBetMoneylineByGame, fetchSxBetTotalsByGame, type SxBetMarkets } from "@/lib/sxbet";
import type { MarketType, NormalizedMarket, Outcome, Sport, VenueId } from "@/types/arbitrage";
import { decimalOddsFromCents, impliedProbFromCents } from "./arbMath";
import { buildEventKey } from "./matching";
import { getMarkets, saveMarkets, setIngestTimings, setRunning } from "./marketStore";
import { SPORTS, type ArbGame, type SportConfig } from "./sports";
import { dateParamToStorageDate } from "./date";

const EMPTY_SX: SxBetMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };
const EMPTY_PM: PolymarketUsMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };
const emptyTotals = () => new Map<string, VenueTotalLine[]>();
const emptyTwoWay = () => new Map<string, VenueTwoWay>();
const emptySpread = () => new Map<string, VenueSpread>();

type Timed<T> = { data: T; fetchedAt: string };

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
  timings: VenueFetchTiming[];
};

// Per-venue, per-market-type fetch diagnostics. `ok:false` distinguishes a FAILED
// fetch (network/venue error) from a successful fetch that simply returned no rows
// (rawCount:0, ok:true) — the two used to look identical (empty map) in the logs.
export type VenueFetchTiming = {
  venueId: VenueId;
  marketType: MarketType;
  durationMs: number;
  ok: boolean;
  rawCount: number;
  error?: string;
};

// Narrows a targeted refresh to only the venues + market types an opportunity needs,
// instead of fanning out to every venue × every market type for the game (the old
// refresh path re-fetched all of them, which is the dominant pre-trade latency).
export type IngestScope = {
  venues?: Set<VenueId>;
  marketTypes?: Set<MarketType>;
};

function scopeAllows(scope: IngestScope | undefined, venue: VenueId, marketType: MarketType): boolean {
  if (!scope) return true;
  if (scope.venues && !scope.venues.has(venue)) return false;
  if (scope.marketTypes && !scope.marketTypes.has(marketType)) return false;
  return true;
}

// Count raw feed rows in either a per-game Map (value = row[]) or a consolidated
// object-of-maps (PolymarketUsMarkets / SxBetMarkets = { moneyline, spread, totals }).
function rawRowCount(data: unknown): number {
  if (data instanceof Map) {
    let n = 0;
    for (const v of data.values()) n += Array.isArray(v) ? v.length : 1;
    return n;
  }
  if (data && typeof data === "object") {
    let n = 0;
    for (const v of Object.values(data as Record<string, unknown>)) n += rawRowCount(v);
    return n;
  }
  return 0;
}

// Polymarket US is a single MLB-only consolidated read (moneyline+spread+totals in one
// pass). Only baseball/mlb may take it — routing WNBA/bra1 here pulled zero rows because
// the fetcher is hard-wired to the MLB tag/market keys.
function usesPolymarketUsConsolidated(cfg: SportConfig): boolean {
  return polymarketRegion() === "us" && cfg.league === "mlb" && Boolean(cfg.markets.totals || cfg.markets.spread);
}

// A single slow venue used to stall the whole scoped refresh (tail latency up to 6.4s).
// Each fetch races a timeout; a timed-out (or errored) venue is marked ok:false and the
// caller keeps that venue's prior cache instead of wiping it. The tight 700ms bound is
// applied ONLY to the latency-critical pre-trade refresh; the full scanner uses the
// generous default cap below so it never drops a venue that just needs a bit longer
// (dropping venues would REDUCE arb coverage — the opposite of the goal).
const VENUE_REFRESH_TIMEOUT_MS = 700;
const VENUE_FETCH_TIMEOUT_MS = 15000;

// Time a single venue fetch, recording duration + ok/error + raw row count so a failed
// fetch is visibly distinct from an empty one. `enabled:false` skips the fetch entirely.
async function timedFetch<T>(
  timings: VenueFetchTiming[],
  venueId: VenueId,
  marketType: MarketType,
  enabled: boolean,
  run: () => Promise<T>,
  empty: T,
  timeoutMs = VENUE_FETCH_TIMEOUT_MS
): Promise<Timed<T>> {
  if (!enabled) return { data: empty, fetchedAt: new Date().toISOString() };
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout>${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    timings.push({ venueId, marketType, durationMs: Date.now() - start, ok: true, rawCount: rawRowCount(data) });
    return { data, fetchedAt: new Date().toISOString() };
  } catch (e) {
    timings.push({ venueId, marketType, durationMs: Date.now() - start, ok: false, rawCount: 0, error: String(e).slice(0, 200) });
    return { data: empty, fetchedAt: new Date().toISOString() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ingestSportMarkets(
  cfg: SportConfig,
  games: ArbGame[],
  scope?: IngestScope,
  fetchTimeoutMs: number = VENUE_FETCH_TIMEOUT_MS
): Promise<{ markets: NormalizedMarket[]; venueCounts: Record<VenueId, number>; timings: VenueFetchTiming[] }> {
  const markets: NormalizedMarket[] = [];
  const venueCounts: Record<VenueId, number> = { kalshi: 0, polymarket: 0, sxbet: 0, predictfun: 0, cloudbet: 0 };
  const timings: VenueFetchTiming[] = [];
  if (!games.length) return { markets, venueCounts, timings };

  const allow = (venue: VenueId, marketType: MarketType) => scopeAllows(scope, venue, marketType);
  // Bind the per-fetch timeout for this ingest (tight for refresh, generous for the scan).
  const tf = <T>(venueId: VenueId, marketType: MarketType, enabled: boolean, run: () => Promise<T>, empty: T) =>
    timedFetch(timings, venueId, marketType, enabled, run, empty, fetchTimeoutMs);
  const freshEmptyTotals = () => ({ data: emptyTotals(), fetchedAt: new Date().toISOString() });
  const freshEmptyTwoWay = () => ({ data: emptyTwoWay(), fetchedAt: new Date().toISOString() });
  const freshEmptySpread = () => ({ data: emptySpread(), fetchedAt: new Date().toISOString() });

  const kalshiPromise = cfg.kalshi
    ? Promise.all([
        tf("kalshi", "total", Boolean(cfg.markets.totals && allow("kalshi", "total")), () => fetchKalshiTotalsByGame(games, cfg.kalshi!.total), emptyTotals()),
        tf("kalshi", "moneyline", Boolean(cfg.markets.moneyline && allow("kalshi", "moneyline")), () => fetchKalshiMoneylineByGame(games, cfg.kalshi!.game), emptyTwoWay()),
        tf("kalshi", "spread", Boolean(cfg.markets.spread && allow("kalshi", "spread")), () => fetchKalshiSpreadByGame(games, cfg.kalshi!.spread, cfg.spreadFixedLine), emptySpread()),
      ])
    : Promise.resolve([freshEmptyTotals(), freshEmptyTwoWay(), freshEmptySpread()] as const);

  const polymarketPromise: Promise<
    readonly [Timed<Map<string, VenueTotalLine[]>>, Timed<Map<string, VenueTwoWay>>, Timed<Map<string, VenueSpread>>]
  > = !cfg.polyTag
    ? Promise.resolve([freshEmptyTotals(), freshEmptyTwoWay(), freshEmptySpread()] as const)
    : usesPolymarketUsConsolidated(cfg)
      ? // One consolidated MLB read; scope can't split it, so fetch when any poly market is wanted.
        tf(
          "polymarket",
          "moneyline",
          allow("polymarket", "moneyline") || allow("polymarket", "total") || allow("polymarket", "spread"),
          () => fetchPolymarketUsMLBMarkets(games),
          EMPTY_PM
        ).then((pm) => [
          { data: pm.data.totals, fetchedAt: pm.fetchedAt },
          { data: pm.data.moneyline, fetchedAt: pm.fetchedAt },
          { data: pm.data.spread, fetchedAt: pm.fetchedAt },
        ] as const)
      : Promise.all([
          tf("polymarket", "total", Boolean(cfg.markets.totals && allow("polymarket", "total")), () => fetchPolymarketTotalsByGame(games, cfg.polyTag!), emptyTotals()),
          tf(
            "polymarket",
            "moneyline",
            Boolean(cfg.markets.moneyline && allow("polymarket", "moneyline")),
            () =>
              cfg.sport === "soccer" || cfg.sport === "tennis"
                ? fetchPolymarketWinnerByGame(games, cfg.polyTag!, cfg.sport === "soccer")
                : fetchPolymarketMoneylineByGame(games, cfg.polyTag!),
            emptyTwoWay()
          ),
          tf("polymarket", "spread", Boolean(cfg.markets.spread && allow("polymarket", "spread")), () => fetchPolymarketSpreadByGame(games, cfg.polyTag!), emptySpread()),
        ]);

  const sxFixed = cfg.sxLeagueId != null;
  const sxPromise = tf("sxbet", "total", sxFixed, () => fetchSxBetMLBMarkets(games, cfg.sxLeagueId!), EMPTY_SX);
  const sxDynMLPromise = tf("sxbet", "moneyline", Boolean(cfg.sxDynamic && allow("sxbet", "moneyline")), () => fetchSxBetMoneylineByGame(games, cfg.sxDynamic!), emptyTwoWay());
  // Dynamic-league SX totals (bra1) — previously missing from this path, so a targeted
  // refresh silently dropped every SX.bet total line the full scan had found.
  const sxDynTotPromise = tf("sxbet", "total", Boolean(cfg.sxDynamic?.totals && cfg.markets.totals && allow("sxbet", "total")), () => fetchSxBetTotalsByGame(games, cfg.sxDynamic!), emptyTotals());
  const pfMLPromise = tf("predictfun", "moneyline", Boolean(cfg.predictfun && allow("predictfun", "moneyline")), () => fetchPredictFunMoneylineByGame(games), emptyTwoWay());
  const cbMLPromise = tf("cloudbet", "moneyline", Boolean(cfg.cloudbet && allow("cloudbet", "moneyline")), () => fetchCloudbetMoneylineByGame(games, cfg.cloudbet!), emptyTwoWay());
  const cbTotPromise = tf("cloudbet", "total", Boolean(cfg.cloudbet?.totals && cfg.markets.totals && allow("cloudbet", "total")), () => fetchCloudbetTotalsByGame(games, cfg.cloudbet!), emptyTotals());
  const cbSpPromise = tf("cloudbet", "spread", Boolean(cfg.cloudbet?.spread && cfg.markets.spread && allow("cloudbet", "spread")), () => fetchCloudbetSpreadByGame(games, cfg.cloudbet!), emptySpread());

  const [[kTot, kML, kSp], [pTot, pML, pSp], sx, sxDynML, sxDynTot, pfML, cbML, cbTot, cbSp] = await Promise.all([
    kalshiPromise,
    polymarketPromise,
    sxPromise,
    sxDynMLPromise,
    sxDynTotPromise,
    pfMLPromise,
    cbMLPromise,
    cbTotPromise,
    cbSpPromise,
  ]);

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
    const sxTotals = cfg.sxDynamic?.totals ? sxDynTot.data.get(game.id) : sx.data.totals.get(game.id);
    const sxTotalsAt = cfg.sxDynamic?.totals ? sxDynTot.fetchedAt : sx.fetchedAt;
    const sRows = [
      ...normalizeVenueTotals("sxbet", game, sxTotals, cfg.sport, cfg.league, sxTotalsAt),
      ...normalizeVenueTwoWay("sxbet", game, sxMoneyline, "moneyline", cfg.sport, cfg.league, sxMoneylineAt),
      ...normalizeVenueTwoWay("sxbet", game, sx.data.spread.get(game.id), "spread", cfg.sport, cfg.league, sx.fetchedAt),
    ];
    const pfRows = normalizeVenueTwoWay("predictfun", game, pfML.data.get(game.id), "moneyline", cfg.sport, cfg.league, pfML.fetchedAt);
    const cbRows = [
      ...normalizeVenueTwoWay("cloudbet", game, cbML.data.get(game.id), "moneyline", cfg.sport, cfg.league, cbML.fetchedAt),
      ...normalizeVenueTotals("cloudbet", game, cbTot.data.get(game.id), cfg.sport, cfg.league, cbTot.fetchedAt),
      ...normalizeVenueTwoWay("cloudbet", game, cbSp.data.get(game.id), "spread", cfg.sport, cfg.league, cbSp.fetchedAt),
    ];
    venueCounts.kalshi += kRows.length;
    venueCounts.polymarket += pRows.length;
    venueCounts.sxbet += sRows.length;
    venueCounts.predictfun += pfRows.length;
    venueCounts.cloudbet += cbRows.length;
    markets.push(...kRows, ...pRows, ...sRows, ...pfRows, ...cbRows);
  }

  return { markets, venueCounts, timings };
}

// Ingest all configured sports for a date. Public market reads — no credentials.
// Fans out per sport through the shared `ingestSportMarkets` (same code path the targeted
// refresh uses), so the scanner and the refresh can never diverge on venue coverage. Each
// sport still fetches its venues concurrently, and the sports run concurrently.
export async function ingestTotals(date: string): Promise<IngestResult> {
  const storageDate = dateParamToStorageDate(date);
  const markets: NormalizedMarket[] = [];
  const venueCounts: Record<VenueId, number> = { kalshi: 0, polymarket: 0, sxbet: 0, predictfun: 0, cloudbet: 0 };
  const timings: VenueFetchTiming[] = [];
  let gameCount = 0;

  await Promise.all(
    SPORTS.map(async (cfg) => {
      const games: ArbGame[] = await cfg.fetchGames(storageDate).catch((e) => {
        console.error(`[arbitrage/ingest] ${cfg.league} games fetch failed:`, e);
        return [];
      });
      gameCount += games.length;
      if (!games.length) return;

      const sport = await ingestSportMarkets(cfg, games);
      markets.push(...sport.markets);
      for (const v of Object.keys(venueCounts) as VenueId[]) venueCounts[v] += sport.venueCounts[v];
      timings.push(...sport.timings);
    })
  );

  await saveMarkets(storageDate, markets);
  setIngestTimings(storageDate, timings);
  return { date: storageDate, gameCount, markets, venueCounts, timings };
}

function opportunityEventKey(opportunityId: string): string | null {
  const parts = opportunityId.split(":");
  if (parts.length < 3) return null;
  return parts.slice(0, -2).join(":");
}

// The opportunity id is `${eventKey}:${marketType}:${line}`. eventKey contains colons
// (sport:league:teams:isoBucket) but marketType/line never do, so the market type is
// always the second-to-last colon segment.
const MARKET_TYPES: MarketType[] = ["moneyline", "total", "spread"];
export function opportunityMarketType(opportunityId: string): MarketType | null {
  const seg = opportunityId.split(":").at(-2);
  return MARKET_TYPES.find((t) => t === seg) ?? null;
}

function marketGameId(market: NormalizedMarket): string | null {
  const parts = market.marketId.split(":");
  return parts.length >= 2 ? parts[1] : null;
}

export type OpportunityRefresh = {
  markets: NormalizedMarket[];
  timings: VenueFetchTiming[];
  gamesFetchMs: number;
  ingestMs: number;
  refreshedMarketType: MarketType | null;
  refreshedVenues: VenueId[];
};

// Refresh ONLY what a live opportunity needs — the single game, and within it only the
// venues + market type the arb's legs use — then merge those rows back into the date
// cache. The old path re-fetched every venue × every market type for the game (the
// dominant pre-trade latency: a 2-venue totals arb only needs 2 venues × 1 market type).
// Untouched venues/markets for the game are preserved on merge.
export async function refreshMarketsForOpportunity(
  date: string,
  opportunityId: string,
  legVenues?: VenueId[]
): Promise<OpportunityRefresh> {
  const storageDate = dateParamToStorageDate(date);
  const current = await getMarkets(storageDate);
  const empty: OpportunityRefresh = { markets: current, timings: [], gamesFetchMs: 0, ingestMs: 0, refreshedMarketType: null, refreshedVenues: [] };
  const eventKey = opportunityEventKey(opportunityId);
  if (!eventKey) return empty;

  const eventMarkets = current.filter((m) => buildEventKey(m) === eventKey);
  const seed = eventMarkets[0];
  const gameId = seed ? marketGameId(seed) : null;
  if (!seed || !gameId) return empty;

  const cfg = SPORTS.find((s) => s.sport === seed.sport && s.league === seed.league);
  if (!cfg) return empty;

  // Scope to the opportunity's market type and — when the caller supplies them — exactly
  // the arb's leg venues (so a slow non-leg venue quoting the same market never sits on the
  // critical path). Otherwise fall back to all venues quoting this game+market-type.
  const marketType = opportunityMarketType(opportunityId);
  const scopeMarkets = marketType ? eventMarkets.filter((m) => m.marketType === marketType) : eventMarkets;
  const cachedVenues = [...new Set(scopeMarkets.map((m) => m.venueId))];
  const venues = legVenues?.length ? [...new Set(legVenues)] : cachedVenues;
  const scope: IngestScope | undefined = marketType
    ? { marketTypes: new Set([marketType]), venues: venues.length ? new Set(venues) : undefined }
    : undefined;

  const gamesStart = Date.now();
  const games = await cfg.fetchGames(storageDate).catch((e) => {
    console.error(`[arbitrage/ingest] targeted ${cfg.league} games fetch failed:`, e);
    return [];
  });
  const gamesFetchMs = Date.now() - gamesStart;
  const game = games.find((g) => g.id === gameId);
  if (!game) {
    const merged = current.filter((m) => !(m.sport === seed.sport && m.league === seed.league && marketGameId(m) === gameId));
    await saveMarkets(storageDate, merged);
    return { ...empty, markets: merged, gamesFetchMs };
  }

  const ingestStart = Date.now();
  // Tight per-venue timeout on the latency-critical refresh; a slow venue falls back to
  // its cached rows (below) rather than stalling the whole pre-trade refresh.
  const fresh = await ingestSportMarkets(cfg, [game], scope, VENUE_REFRESH_TIMEOUT_MS);
  const ingestMs = Date.now() - ingestStart;
  if (!fresh.markets.length) return { ...empty, timings: fresh.timings, gamesFetchMs, ingestMs, refreshedMarketType: marketType, refreshedVenues: venues };

  // A venue whose scoped fetch failed/timed out keeps its PRIOR cache instead of being
  // wiped — otherwise a timeout would delete the venue's rows and manufacture an
  // "opportunity no longer exists" on the very leg we're trying to confirm.
  const failedVenues = new Set(fresh.timings.filter((t) => !t.ok).map((t) => t.venueId));
  const refreshedTypes = scope?.marketTypes;
  const refreshedVenueSet = new Set(venues.filter((v) => !failedVenues.has(v)));

  // Replace only the (game, refreshed market types, successfully-refreshed venues) rows.
  const isRefreshedRow = (m: NormalizedMarket) =>
    m.sport === seed.sport &&
    m.league === seed.league &&
    marketGameId(m) === gameId &&
    (!refreshedTypes || refreshedTypes.has(m.marketType)) &&
    refreshedVenueSet.has(m.venueId);
  // Only keep the fresh rows for venues we're actually replacing (drop rows from a venue
  // that timed out but happened to return partial data late — its cache stays authoritative).
  const freshRows = fresh.markets.filter((m) => refreshedVenueSet.has(m.venueId));
  const merged = current.filter((m) => !isRefreshedRow(m));
  merged.push(...freshRows);
  await saveMarkets(storageDate, merged);
  return { markets: merged, timings: fresh.timings, gamesFetchMs, ingestMs, refreshedMarketType: marketType, refreshedVenues: venues };
}

// Fire-and-forget wrapper used by the run route; manages the running flag.
export async function runIngestion(date: string): Promise<void> {
  const storageDate = dateParamToStorageDate(date);
  setRunning(storageDate, true);
  try {
    const r = await ingestTotals(storageDate);
    console.log(
      `[arbitrage/ingest] ${storageDate}: ${r.gameCount} games, ` +
        `${r.venueCounts.kalshi} Kalshi + ${r.venueCounts.polymarket} Polymarket + ${r.venueCounts.sxbet} SX.bet + ${r.venueCounts.predictfun} predict.fun + ${r.venueCounts.cloudbet} CloudBet quotes`
    );
  } catch (e) {
    console.error(`[arbitrage/ingest] ${storageDate} failed:`, e);
  } finally {
    setRunning(storageDate, false);
  }
}
