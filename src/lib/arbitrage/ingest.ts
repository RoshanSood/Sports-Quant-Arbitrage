// Ingestion: for each configured sport, fetch games + Kalshi/Polymarket/SX.bet
// markets (totals / moneyline / spread), normalize into the shared NormalizedMarket
// model, and persist. The matching + arb engines key events by sport:league:teams,
// so MLB and WNBA share one pipeline without cross-matching.

import {
  fetchKalshiF5MoneylineByGame,
  fetchKalshiMoneylineByGame,
  fetchKalshiPlayerMatchByGame,
  fetchKalshiSpreadByGame,
  fetchKalshiThreeWayMoneylineByGame,
  fetchKalshiTotalsByGame,
  type VenueSpread,
  type VenueTotalLine,
  type VenueTwoWay,
} from "@/lib/kalshi";
import {
  fetchPolymarketF5WinnerByGame,
  fetchPolymarketMoneylineByGame,
  fetchPolymarketSpreadByGame,
  fetchPolymarketTotalsByGame,
  fetchPolymarketWinnerByGame,
} from "@/lib/polymarket";
import { fetchPolymarketUsMLBMarkets, type PolymarketUsMarkets } from "@/lib/polymarketUs";
import { polymarketRegion } from "@/lib/polymarketRegion";
import { polymarketLiveBook } from "./polymarketLiveBook";
import { kalshiLiveBook } from "./kalshiLiveBook";
import { sxbetLiveBook } from "./sxbetLiveBook";
import { fetchPredictFunMoneylineByGame } from "@/lib/predictFun";
import { fetchCloudbetMoneylineByGame, fetchCloudbetSpreadByGame, fetchCloudbetTotalsByGame } from "@/lib/cloudbet";
import { fetchSxBetMLBMarkets, fetchSxBetMoneylineByGame, fetchSxBetTotalsByGame, type SxBetMarkets } from "@/lib/sxbet";
import type { MarketSegment, MarketType, NormalizedMarket, Outcome, Sport, VenueId } from "@/types/arbitrage";
import { decimalOddsFromCents, impliedProbFromCents } from "./arbMath";
import { buildEventKey } from "./matching";
import { getMarkets, saveMarkets, setRunning } from "./marketStore";
import { SPORTS, type ArbGame, type SportConfig } from "./sports";

// Narrows a targeted pre-trade refresh to only the venues + market type an opportunity
// actually needs, instead of re-fetching every venue × every market type for the game
// (the dominant placement latency: a 2-venue moneyline arb only needs 2 venues × 1 type).
// Hard cap on the targeted pre-trade refresh so a hung venue fetch can't block placement.
const REFRESH_TIMEOUT_MS = 3000;
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

// If the live socket (polymarketLiveBook.ts) has a FRESH quote for this Polymarket CLOB
// token, prefer its ask over the REST snapshot price — the socket can be many seconds (or
// minutes, under load) fresher than the last poll cycle, which is what actually determines
// whether a detected arb still exists by the time an order is placed. Liquidity/depth still
// comes from the REST snapshot (the lightweight price_change stream doesn't carry it, and
// depth moves far more slowly than price, so a slightly-stale depth figure next to a live
// price is a reasonable tradeoff). Only applies to the intl CLOB — Polymarket US is a
// different, unrelated venue with no socket feed here. Returns null (use REST) otherwise.
function livePolymarketAskCents(venueId: VenueId, nativeSide: string | undefined): number | null {
  if (venueId !== "polymarket" || !nativeSide || polymarketRegion() === "us") return null;
  return polymarketLiveBook.getQuote(nativeSide)?.bestAskCents ?? null;
}

// Same idea for Kalshi (kalshiLiveBook.ts) — keyed by ticker (nativeMarketId) + yes/no side
// (nativeSide), since Kalshi's book is one ticker with two sides rather than one token per
// outcome. NOT live-verified (see that file's header) — returns null (use REST) until proven
// live, so this can never surface a wrong price, only fail to speed one up.
function liveKalshiAskCents(venueId: VenueId, nativeMarketId: string | undefined, nativeSide: string | undefined): number | null {
  if (venueId !== "kalshi" || !nativeMarketId) return null;
  const q = kalshiLiveBook.getQuote(nativeMarketId);
  if (!q) return null;
  return nativeSide === "no" ? q.noAskCents : q.yesAskCents;
}

// Same idea for SX.bet (sxbetLiveBook.ts, Centrifugo) — keyed by market hash + outcome
// one/two side. NOT live-verified (see that file's header) — same fail-safe behavior.
function liveSxAskCents(venueId: VenueId, nativeMarketId: string | undefined, nativeSide: string | undefined): number | null {
  if (venueId !== "sxbet" || !nativeMarketId) return null;
  const q = sxbetLiveBook.getQuote(nativeMarketId);
  if (!q) return null;
  return nativeSide === "two" ? q.o2AskCents : nativeSide === "one" ? q.o1AskCents : null;
}

function normalizeVenueTotals(
  venueId: VenueId,
  game: ArbGame,
  lines: VenueTotalLine[] | undefined,
  sport: Sport,
  league: string,
  now: string,
  segment: MarketSegment = "full_game"
): NormalizedMarket[] {
  if (!lines?.length) return [];
  const teams: [string, string] = [game.awayTeam.shortName, game.homeTeam.shortName];
  // Segment rides in the synthetic marketId so an F5 row can never collide with a full-game
  // row of the same venue/line/outcome (both share the numeric line, e.g. O/U 2.5).
  const segTag = segment === "full_game" ? "" : `${segment}:`;
  const rows: NormalizedMarket[] = [];
  for (const l of lines) {
    for (const [outcome, priceCents, liqUsd, tokenId, sxIsOne] of [
      ["over", l.overCents, l.overLiquidityUsd, l.overTokenId, l.overIsOutcomeOne] as const,
      ["under", l.underCents, l.underLiquidityUsd, l.underTokenId, l.overIsOutcomeOne === undefined ? undefined : !l.overIsOutcomeOne] as const,
    ]) {
      if (priceCents <= 0 || priceCents >= 100) continue;
      const liquidityUsd = Number.isFinite(liqUsd) ? Math.round(liqUsd) : 0;
      const nativeSide = nativeSideFor(venueId, { kalshiYesNo: outcome === "over" ? "yes" : "no", polyTokenId: tokenId, sxIsOne });
      // Prefer a fresh live-socket ask over the REST snapshot price, where available.
      const effectivePriceCents =
        livePolymarketAskCents(venueId, nativeSide) ??
        liveKalshiAskCents(venueId, l.marketId, nativeSide) ??
        liveSxAskCents(venueId, l.marketId, nativeSide) ??
        priceCents;
      rows.push({
        venueId,
        marketId: `${venueId}:${game.id}:total:${segTag}${l.line}:${outcome}`,
        // Kalshi totals: buying OVER = buy YES, UNDER = buy NO, on the line's ticker.
        nativeMarketId: l.marketId,
        nativeSide,
        sourceStartTime: l.sourceStartTime,
        sport,
        league,
        startTime: game.date,
        teams,
        marketType: "total",
        line: l.line,
        outcome,
        priceCents: effectivePriceCents,
        decimalOdds: decimalOddsFromCents(effectivePriceCents),
        impliedProbability: impliedProbFromCents(effectivePriceCents),
        depth: effectivePriceCents > 0 ? Math.floor(liquidityUsd / (effectivePriceCents / 100)) : 0,
        liquidityUsd,
        live: true,
        status: "open",
        lastUpdated: now,
        segment,
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
  now: string,
  segment: MarketSegment = "full_game"
): NormalizedMarket[] {
  if (!q) return [];
  const teams: [string, string] = [game.awayTeam.shortName, game.homeTeam.shortName];
  const line = marketType === "spread" ? q.homeSignedLine ?? null : null;
  const lineKey = marketType === "spread" ? String(q.homeSignedLine ?? 0) : "0";
  const segTag = segment === "full_game" ? "" : `${segment}:`;
  const rows: NormalizedMarket[] = [];
  const sides: Array<readonly [Outcome, number | undefined, number | undefined, string | undefined, boolean | undefined]> = [
    ["home", q.homeCents, q.homeLiquidityUsd, q.homeTokenId, q.homeIsOutcomeOne],
    ["away", q.awayCents, q.awayLiquidityUsd, q.awayTokenId, q.homeIsOutcomeOne === undefined ? undefined : !q.homeIsOutcomeOne],
  ];
  // 3-way (soccer 1X2, MLB F5 winner): a third leg when the venue supplied a draw price.
  if (marketType === "moneyline" && typeof q.drawCents === "number") {
    sides.push(["draw", q.drawCents, q.drawLiquidityUsd, q.drawTokenId, undefined]);
  }
  for (const [outcome, priceCents, liqUsd, tokenId, sxIsOne] of sides) {
    if (priceCents == null || priceCents <= 0 || priceCents >= 100) continue;
    const liquidityUsd = typeof liqUsd === "number" && Number.isFinite(liqUsd) ? Math.round(liqUsd) : 0;
    const nativeSide = nativeSideFor(venueId, {
      kalshiYesNo: q.yesSide == null ? "yes" : outcome === q.yesSide ? "yes" : "no",
      polyTokenId: tokenId,
      sxIsOne,
    });
    // Kalshi two-way (full game/spread): ONE ticker, buy YES on the team the market's YES
    // side represents, else NO — q.yesSide is set. Kalshi F5 (and any venue's 3-way 1X2):
    // EACH outcome has its OWN dedicated ticker (id carried in tokenId), always bought at
    // its own YES — q.yesSide is left unset by that fetch path to signal this.
    const nativeMarketId = (venueId === "sxbet" || (venueId === "kalshi" && q.yesSide == null)) && tokenId ? tokenId : q.marketId;
    // Prefer a fresh live-socket ask over the REST snapshot price, where available.
    const effectivePriceCents =
      livePolymarketAskCents(venueId, nativeSide) ??
      liveKalshiAskCents(venueId, nativeMarketId, nativeSide) ??
      liveSxAskCents(venueId, nativeMarketId, nativeSide) ??
      priceCents;
    rows.push({
      venueId,
      marketId: `${venueId}:${game.id}:${marketType}:${segTag}${lineKey}:${outcome}`,
      nativeMarketId,
      nativeSide,
      sourceStartTime: q.sourceStartTime,
      sport,
      league,
      startTime: game.date,
      teams,
      marketType,
      line,
      outcome: outcome as Outcome,
      priceCents: effectivePriceCents,
      decimalOdds: decimalOddsFromCents(effectivePriceCents),
      impliedProbability: impliedProbFromCents(effectivePriceCents),
      depth: effectivePriceCents > 0 ? Math.floor(liquidityUsd / (effectivePriceCents / 100)) : 0,
      liquidityUsd,
      live: true,
      status: "open",
      lastUpdated: now,
      segment,
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

  // Every venue (full game AND F5, where configured) is fetched CONCURRENTLY. These used to
  // be awaited one after another, so a cycle took the SUM of every venue's latency and the
  // first-fetched quotes were already stale by the time the last venue returned — the main
  // reason detected arbs vanished at execution. This makes a cycle take the MAX single-venue
  // latency instead. Each fetch is wrapped in withFetchedAt (never rejects), so one slow or
  // failing venue can't block the others.
  // Tennis (per-player independent tickers, no totals/spread) reads through
  // fetchKalshiPlayerMatchByGame instead of the standard one-ticker+complement moneyline
  // reader — same distinction Polymarket already makes via `winnerSport` below.
  const kalshiP = cfg.kalshi
    ? Promise.all([
        cfg.markets.totals && cfg.kalshi.total && allow("kalshi", "total") ? withFetchedAt(fetchKalshiTotalsByGame(games, cfg.kalshi.total), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
        cfg.markets.moneyline && allow("kalshi", "moneyline")
          ? withFetchedAt(
              cfg.kalshi.threeWay
                ? fetchKalshiThreeWayMoneylineByGame(games, cfg.kalshi.game)
                : cfg.sport === "tennis"
                  ? fetchKalshiPlayerMatchByGame(games, cfg.kalshi.game)
                  : fetchKalshiMoneylineByGame(games, cfg.kalshi.game),
              emptyTwoWay()
            )
          : Promise.resolve(freshEmptyTwoWay()),
        cfg.markets.spread && cfg.kalshi.spread && allow("kalshi", "spread") ? withFetchedAt(fetchKalshiSpreadByGame(games, cfg.kalshi.spread, cfg.spreadFixedLine), emptySpread()) : Promise.resolve(freshEmptySpread()),
      ])
    : Promise.resolve([freshEmptyTotals(), freshEmptyTwoWay(), freshEmptySpread()] as const);

  // F5 (first-5-innings) ladder — same shape as full game, fetched from the parallel KXMLBF5*
  // series. MLB F5 winner uses fetchKalshiF5MoneylineByGame (per-team + tie tickers, NOT the
  // full-game complement-based fetcher — see that function's comment for why).
  const kalshiF5P = cfg.f5?.kalshi
    ? Promise.all([
        allow("kalshi", "total") ? withFetchedAt(fetchKalshiTotalsByGame(games, cfg.f5.kalshi.total), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
        allow("kalshi", "moneyline") ? withFetchedAt(fetchKalshiF5MoneylineByGame(games, cfg.f5.kalshi.game), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay()),
        allow("kalshi", "spread") ? withFetchedAt(fetchKalshiSpreadByGame(games, cfg.f5.kalshi.spread, 1.5), emptySpread()) : Promise.resolve(freshEmptySpread()),
      ])
    : Promise.resolve([freshEmptyTotals(), freshEmptyTwoWay(), freshEmptySpread()] as const);

  const polyP: Promise<{ pTot: Timed<Map<string, VenueTotalLine[]>>; pML: Timed<Map<string, VenueTwoWay>>; pSp: Timed<Map<string, VenueSpread>> }> = (async () => {
    if (!(cfg.polyTag && allowV("polymarket"))) return { pTot: freshEmptyTotals(), pML: freshEmptyTwoWay(), pSp: freshEmptySpread() };
    if ((cfg.markets.totals || cfg.markets.spread) && polymarketRegion() === "us") {
      const pm = await withFetchedAt(fetchPolymarketUsMLBMarkets(games), EMPTY_PM);
      return {
        pTot: { data: pm.data.totals, fetchedAt: pm.fetchedAt },
        pML: { data: pm.data.moneyline, fetchedAt: pm.fetchedAt },
        pSp: { data: pm.data.spread, fetchedAt: pm.fetchedAt },
      };
    }
    const tag = cfg.polyTag;
    const winnerSport = cfg.sport === "soccer" || cfg.sport === "tennis";
    const [pTot, pML, pSp] = await Promise.all([
      cfg.markets.totals && allow("polymarket", "total") ? withFetchedAt(fetchPolymarketTotalsByGame(games, tag), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
      cfg.markets.moneyline && allow("polymarket", "moneyline")
        ? withFetchedAt(winnerSport ? fetchPolymarketWinnerByGame(games, tag, cfg.sport === "soccer") : fetchPolymarketMoneylineByGame(games, tag), emptyTwoWay())
        : Promise.resolve(freshEmptyTwoWay()),
      cfg.markets.spread && allow("polymarket", "spread") ? withFetchedAt(fetchPolymarketSpreadByGame(games, tag), emptySpread()) : Promise.resolve(freshEmptySpread()),
    ]);
    return { pTot, pML, pSp };
  })();

  // Polymarket F5: totals/spread reuse the full-game fetchers with segment="f5" (a single
  // Polymarket event mixes full-game and F5 markets together, so this is what tells them
  // apart). Winner uses the dedicated fetchPolymarketF5WinnerByGame (per-team + tie markets).
  const polyF5P: Promise<{ pTot: Timed<Map<string, VenueTotalLine[]>>; pML: Timed<Map<string, VenueTwoWay>>; pSp: Timed<Map<string, VenueSpread>> }> = (async () => {
    if (!(cfg.f5?.polyTag && allowV("polymarket"))) return { pTot: freshEmptyTotals(), pML: freshEmptyTwoWay(), pSp: freshEmptySpread() };
    const tag = cfg.f5.polyTag;
    const [pTot, pML, pSp] = await Promise.all([
      allow("polymarket", "total") ? withFetchedAt(fetchPolymarketTotalsByGame(games, tag, "f5"), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
      allow("polymarket", "moneyline") ? withFetchedAt(fetchPolymarketF5WinnerByGame(games, tag), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay()),
      allow("polymarket", "spread") ? withFetchedAt(fetchPolymarketSpreadByGame(games, tag, "f5"), emptySpread()) : Promise.resolve(freshEmptySpread()),
    ]);
    return { pTot, pML, pSp };
  })();

  const sxP = cfg.sxLeagueId != null && allowV("sxbet") ? withFetchedAt(fetchSxBetMLBMarkets(games, cfg.sxLeagueId), EMPTY_SX) : Promise.resolve({ data: EMPTY_SX, fetchedAt: new Date().toISOString() });
  const sxDynP = cfg.sxDynamic && allow("sxbet", "moneyline") ? withFetchedAt(fetchSxBetMoneylineByGame(games, cfg.sxDynamic), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay());
  // Dynamic SX totals (soccer leagues enumerated live rather than a fixed league id, e.g.
  // Brazil Série A) — separate from the fixed-league sxP.data.totals above.
  const sxDynTotalsP =
    cfg.sxDynamic?.totals && cfg.markets.totals && allow("sxbet", "total")
      ? withFetchedAt(fetchSxBetTotalsByGame(games, cfg.sxDynamic), emptyTotals())
      : Promise.resolve(freshEmptyTotals());
  const pfP = cfg.predictfun && allow("predictfun", "moneyline") ? withFetchedAt(fetchPredictFunMoneylineByGame(games), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay());
  const cbP = cfg.cloudbet
    ? Promise.all([
        cfg.markets.totals && cfg.cloudbet.total && allow("cloudbet", "total")
          ? withFetchedAt(fetchCloudbetTotalsByGame(games, cfg.cloudbet), emptyTotals())
          : Promise.resolve(freshEmptyTotals()),
        cfg.markets.moneyline && allow("cloudbet", "moneyline")
          ? withFetchedAt(fetchCloudbetMoneylineByGame(games, cfg.cloudbet), emptyTwoWay())
          : Promise.resolve(freshEmptyTwoWay()),
        cfg.markets.spread && cfg.cloudbet.spread && allow("cloudbet", "spread")
          ? withFetchedAt(fetchCloudbetSpreadByGame(games, cfg.cloudbet), emptySpread())
          : Promise.resolve(freshEmptySpread()),
      ])
    : Promise.resolve([freshEmptyTotals(), freshEmptyTwoWay(), freshEmptySpread()] as const);

  const [[kTot, kML, kSp], [kF5Tot, kF5ML, kF5Sp], poly, polyF5, sx, sxDynML, sxDynTotals, pfML, [cbTot, cbML, cbSp]] = await Promise.all([
    kalshiP,
    kalshiF5P,
    polyP,
    polyF5P,
    sxP,
    sxDynP,
    sxDynTotalsP,
    pfP,
    cbP,
  ]);
  const { pTot, pML, pSp } = poly;
  const { pTot: pF5Tot, pML: pF5ML, pSp: pF5Sp } = polyF5;

  for (const game of games) {
    const kRows = [
      ...normalizeVenueTotals("kalshi", game, kTot.data.get(game.id), cfg.sport, cfg.league, kTot.fetchedAt),
      ...normalizeVenueTwoWay("kalshi", game, kML.data.get(game.id), "moneyline", cfg.sport, cfg.league, kML.fetchedAt),
      ...normalizeVenueTwoWay("kalshi", game, kSp.data.get(game.id), "spread", cfg.sport, cfg.league, kSp.fetchedAt),
      ...normalizeVenueTotals("kalshi", game, kF5Tot.data.get(game.id), cfg.sport, cfg.league, kF5Tot.fetchedAt, "f5"),
      ...normalizeVenueTwoWay("kalshi", game, kF5ML.data.get(game.id), "moneyline", cfg.sport, cfg.league, kF5ML.fetchedAt, "f5"),
      ...normalizeVenueTwoWay("kalshi", game, kF5Sp.data.get(game.id), "spread", cfg.sport, cfg.league, kF5Sp.fetchedAt, "f5"),
    ];
    const pRows = [
      ...normalizeVenueTotals("polymarket", game, pTot.data.get(game.id), cfg.sport, cfg.league, pTot.fetchedAt),
      ...normalizeVenueTwoWay("polymarket", game, pML.data.get(game.id), "moneyline", cfg.sport, cfg.league, pML.fetchedAt),
      ...normalizeVenueTwoWay("polymarket", game, pSp.data.get(game.id), "spread", cfg.sport, cfg.league, pSp.fetchedAt),
      ...normalizeVenueTotals("polymarket", game, pF5Tot.data.get(game.id), cfg.sport, cfg.league, pF5Tot.fetchedAt, "f5"),
      ...normalizeVenueTwoWay("polymarket", game, pF5ML.data.get(game.id), "moneyline", cfg.sport, cfg.league, pF5ML.fetchedAt, "f5"),
      ...normalizeVenueTwoWay("polymarket", game, pF5Sp.data.get(game.id), "spread", cfg.sport, cfg.league, pF5Sp.fetchedAt, "f5"),
    ];
    const sxMoneyline = cfg.sxDynamic ? sxDynML.data.get(game.id) : sx.data.moneyline.get(game.id);
    const sxMoneylineAt = cfg.sxDynamic ? sxDynML.fetchedAt : sx.fetchedAt;
    const sxTotals = cfg.sxDynamic?.totals ? sxDynTotals.data.get(game.id) : sx.data.totals.get(game.id);
    const sxTotalsAt = cfg.sxDynamic?.totals ? sxDynTotals.fetchedAt : sx.fetchedAt;
    const sRows = [
      ...normalizeVenueTotals("sxbet", game, sxTotals, cfg.sport, cfg.league, sxTotalsAt),
      ...normalizeVenueTwoWay("sxbet", game, sxMoneyline, "moneyline", cfg.sport, cfg.league, sxMoneylineAt),
      ...normalizeVenueTwoWay("sxbet", game, sx.data.spread.get(game.id), "spread", cfg.sport, cfg.league, sx.fetchedAt),
    ];
    const pfRows = normalizeVenueTwoWay("predictfun", game, pfML.data.get(game.id), "moneyline", cfg.sport, cfg.league, pfML.fetchedAt);
    const cbRows = [
      ...normalizeVenueTotals("cloudbet", game, cbTot.data.get(game.id), cfg.sport, cfg.league, cbTot.fetchedAt),
      ...normalizeVenueTwoWay("cloudbet", game, cbML.data.get(game.id), "moneyline", cfg.sport, cfg.league, cbML.fetchedAt),
      ...normalizeVenueTwoWay("cloudbet", game, cbSp.data.get(game.id), "spread", cfg.sport, cfg.league, cbSp.fetchedAt),
    ];
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
// The main full-day ingest pass (triggered by the scanner / "refresh=1"). Delegates ALL
// per-sport venue fetching to ingestSportMarkets — this function used to duplicate that
// logic inline (sequentially, and without F5 support), which meant two independent, drifting
// copies of "how to fetch a sport's markets": bugs fixed in one silently did not apply to the
// other. Concretely, this is why the F5 fix and the parallel-fetch speed fix did not reach
// the live scanner even after being built — they only landed in ingestSportMarkets, which
// was reachable solely from the narrow pre-trade refresh, not from the main scan. Now there
// is exactly one implementation, so a fix here is a fix everywhere.
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

      const { markets: sportMarkets, venueCounts: sportCounts } = await ingestSportMarkets(cfg, games);
      markets.push(...sportMarkets);
      for (const v of Object.keys(sportCounts) as VenueId[]) venueCounts[v] += sportCounts[v];
    })
  );

  await saveMarkets(date, markets);

  // Keep the Polymarket live-book socket subscribed to exactly today's markets. REST is
  // still how markets are DISCOVERED (new games, new lines); the socket then keeps those
  // specific books fresher than the next poll cycle could. Full-set replace is safe here
  // because this is the FULL scan — a narrower caller (the single-opportunity pre-trade
  // refresh) must never call this, or it would unsubscribe every other game's coverage.
  if (polymarketRegion() !== "us") {
    const tokens = markets.filter((m) => m.venueId === "polymarket" && m.nativeSide).map((m) => m.nativeSide!);
    polymarketLiveBook.connect();
    polymarketLiveBook.setTokens(tokens);
  }
  // Same for Kalshi and SX.bet — both no-op (empty subscribe list, and connect() itself
  // no-ops) until credentials are configured, so always safe to call.
  const kalshiTickers = markets.filter((m) => m.venueId === "kalshi" && m.nativeMarketId).map((m) => m.nativeMarketId!);
  kalshiLiveBook.setTickers(kalshiTickers);
  const sxHashes = markets.filter((m) => m.venueId === "sxbet" && m.nativeMarketId).map((m) => m.nativeMarketId!);
  // REST ingestion has already succeeded. A supplemental socket failure must not abort
  // the scan cycle or suppress publication of the newly saved market snapshot.
  try {
    sxbetLiveBook.setMarkets(sxHashes);
  } catch (error) {
    console.error("[arbitrage/ingest] SX live-book sync failed; continuing with REST books:", error);
  }

  return { date, gameCount, markets, venueCounts };
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

  // Do not turn a fixture-feed failure into an empty slate. A real empty/missing result
  // means ESPN no longer considers the game active (normally because it is final), while
  // a thrown request error means we simply do not know and must leave the cache untouched.
  const games = await cfg.fetchGames(date);
  const game = games.find((g) => g.id === gameId);
  if (!game) {
    // The active-games feed has dropped this fixture. Evict every cached market for the
    // physical event so the next detect cannot reconstruct and retry a finished game.
    const withoutFinishedEvent = current.filter((m) => buildEventKey(m) !== eventKey);
    await saveMarkets(date, withoutFinishedEvent);
    return withoutFinishedEvent;
  }

  // Cap the pre-trade refresh: if a venue fetch hangs, fall back to the cached quotes
  // (the stale-quote gate then decides) instead of blocking placement for minutes.
  const fresh = await Promise.race([
    ingestSportMarkets(cfg, [game], scope),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), REFRESH_TIMEOUT_MS)),
  ]);
  if (!fresh || !fresh.markets.length) return current;

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
export async function runIngestion(date: string): Promise<void> {
  setRunning(date, true);
  try {
    const r = await ingestTotals(date);
    console.log(
      `[arbitrage/ingest] ${date}: ${r.gameCount} games, ` +
        `${r.venueCounts.kalshi} Kalshi + ${r.venueCounts.polymarket} Polymarket + ${r.venueCounts.sxbet} SX.bet + ${r.venueCounts.predictfun} predict.fun + ${r.venueCounts.cloudbet} CloudBet quotes`
    );
  } catch (e) {
    console.error(`[arbitrage/ingest] ${date} failed:`, e);
  } finally {
    setRunning(date, false);
  }
}
