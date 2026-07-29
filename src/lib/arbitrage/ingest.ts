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
import type { NormalizedMarket, Outcome, Sport, VenueId } from "@/types/arbitrage";
import { decimalOddsFromCents, impliedProbFromCents } from "./arbMath";
import { buildEventKey } from "./matching";
import { getMarkets, saveMarkets, setRunning } from "./marketStore";
import { SPORTS, type ArbGame, type SportConfig } from "./sports";

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
  games: ArbGame[]
): Promise<{ markets: NormalizedMarket[]; venueCounts: Record<VenueId, number> }> {
  const markets: NormalizedMarket[] = [];
  const venueCounts: Record<VenueId, number> = { kalshi: 0, polymarket: 0, sxbet: 0, predictfun: 0, cloudbet: 0 };
  if (!games.length) return { markets, venueCounts };

  const freshEmptyTotals = () => ({ data: emptyTotals(), fetchedAt: new Date().toISOString() });
  const freshEmptyTwoWay = () => ({ data: emptyTwoWay(), fetchedAt: new Date().toISOString() });
  const freshEmptySpread = () => ({ data: emptySpread(), fetchedAt: new Date().toISOString() });

  const [kTot, kML, kSp] = cfg.kalshi
    ? await Promise.all([
        cfg.markets.totals ? withFetchedAt(fetchKalshiTotalsByGame(games, cfg.kalshi.total), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
        cfg.markets.moneyline ? withFetchedAt(fetchKalshiMoneylineByGame(games, cfg.kalshi.game), emptyTwoWay()) : Promise.resolve(freshEmptyTwoWay()),
        cfg.markets.spread ? withFetchedAt(fetchKalshiSpreadByGame(games, cfg.kalshi.spread, cfg.spreadFixedLine), emptySpread()) : Promise.resolve(freshEmptySpread()),
      ])
    : [freshEmptyTotals(), freshEmptyTwoWay(), freshEmptySpread()];

  let pTot: Timed<Map<string, VenueTotalLine[]>> = freshEmptyTotals();
  let pML: Timed<Map<string, VenueTwoWay>> = freshEmptyTwoWay();
  let pSp: Timed<Map<string, VenueSpread>> = freshEmptySpread();
  if (cfg.polyTag) {
    if ((cfg.markets.totals || cfg.markets.spread) && polymarketRegion() === "us") {
      const pm = await withFetchedAt(fetchPolymarketUsMLBMarkets(games), EMPTY_PM);
      pTot = { data: pm.data.totals, fetchedAt: pm.fetchedAt };
      pML = { data: pm.data.moneyline, fetchedAt: pm.fetchedAt };
      pSp = { data: pm.data.spread, fetchedAt: pm.fetchedAt };
    } else {
      const tag = cfg.polyTag;
      const winnerSport = cfg.sport === "soccer" || cfg.sport === "tennis";
      [pTot, pML, pSp] = await Promise.all([
        cfg.markets.totals ? withFetchedAt(fetchPolymarketTotalsByGame(games, tag), emptyTotals()) : Promise.resolve(freshEmptyTotals()),
        cfg.markets.moneyline
          ? withFetchedAt(winnerSport ? fetchPolymarketWinnerByGame(games, tag, cfg.sport === "soccer") : fetchPolymarketMoneylineByGame(games, tag), emptyTwoWay())
          : Promise.resolve(freshEmptyTwoWay()),
        cfg.markets.spread ? withFetchedAt(fetchPolymarketSpreadByGame(games, tag), emptySpread()) : Promise.resolve(freshEmptySpread()),
      ]);
    }
  }

  const sx = cfg.sxLeagueId != null ? await withFetchedAt(fetchSxBetMLBMarkets(games, cfg.sxLeagueId), EMPTY_SX) : { data: EMPTY_SX, fetchedAt: new Date().toISOString() };
  const sxDynML = cfg.sxDynamic ? await withFetchedAt(fetchSxBetMoneylineByGame(games, cfg.sxDynamic), emptyTwoWay()) : freshEmptyTwoWay();
  const pfML = cfg.predictfun ? await withFetchedAt(fetchPredictFunMoneylineByGame(games), emptyTwoWay()) : freshEmptyTwoWay();
  const cbML = cfg.cloudbet ? await withFetchedAt(fetchCloudbetMoneylineByGame(games, cfg.cloudbet), emptyTwoWay()) : freshEmptyTwoWay();
  const cbTot =
    cfg.cloudbet && cfg.cloudbet.totals && cfg.markets.totals
      ? await withFetchedAt(fetchCloudbetTotalsByGame(games, cfg.cloudbet), emptyTotals())
      : freshEmptyTotals();
  const cbSp =
    cfg.cloudbet && cfg.cloudbet.spread && cfg.markets.spread
      ? await withFetchedAt(fetchCloudbetSpreadByGame(games, cfg.cloudbet), emptySpread())
      : freshEmptySpread();

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

      // Fetch each venue that CARRIES this sport (config-gated) and only the market types
      // it declares — soccer/tennis are moneyline-only and skip Kalshi/predict.fun/SX.
      const emptyTot = () => new Map<string, VenueTotalLine[]>();
      const emptyTwo = () => new Map<string, VenueTwoWay>();
      const emptySpr = () => new Map<string, VenueSpread>();

      // Kalshi (US series) — sports with a Kalshi series only (MLB/WNBA).
      const [kTot, kML, kSp] = cfg.kalshi
        ? await Promise.all([
            cfg.markets.totals ? fetchKalshiTotalsByGame(games, cfg.kalshi.total).catch(emptyTot) : Promise.resolve(emptyTot()),
            cfg.markets.moneyline ? fetchKalshiMoneylineByGame(games, cfg.kalshi.game).catch(emptyTwo) : Promise.resolve(emptyTwo()),
            cfg.markets.spread ? fetchKalshiSpreadByGame(games, cfg.kalshi.spread, cfg.spreadFixedLine).catch(emptySpr) : Promise.resolve(emptySpr()),
          ])
        : [emptyTot(), emptyTwo(), emptySpr()];

      // Polymarket — US consolidated pass (MLB) or intl per-market by tag.
      let pTot = emptyTot(), pML = emptyTwo(), pSp = emptySpr();
      if (cfg.polyTag) {
        if ((cfg.markets.totals || cfg.markets.spread) && polymarketRegion() === "us") {
          const pm = await fetchPolymarketUsMLBMarkets(games).catch(() => EMPTY_PM);
          pTot = pm.totals; pML = pm.moneyline; pSp = pm.spread;
        } else {
          const tag = cfg.polyTag;
          // Soccer on Polymarket is per-outcome Yes/No "winner" markets (1X2).
          // Tennis match winners are single 2-outcome markets, so use the ML parser.
          const winnerSport = cfg.sport === "soccer";
          [pTot, pML, pSp] = await Promise.all([
            cfg.markets.totals ? fetchPolymarketTotalsByGame(games, tag).catch(emptyTot) : Promise.resolve(emptyTot()),
            cfg.markets.moneyline
              ? (winnerSport
                  ? fetchPolymarketWinnerByGame(games, tag, cfg.sport === "soccer")
                  : fetchPolymarketMoneylineByGame(games, tag)
                ).catch(emptyTwo)
              : Promise.resolve(emptyTwo()),
            cfg.markets.spread ? fetchPolymarketSpreadByGame(games, tag).catch(emptySpr) : Promise.resolve(emptySpr()),
          ]);
        }
      }

      // SX.bet — MLB/WNBA use the fixed-league totals/ml/spread reader; soccer/tennis use
      // the dynamic moneyline reader (enumerated leagues; soccer 1X2, tennis 2-way).
      const sx = cfg.sxLeagueId != null ? await fetchSxBetMLBMarkets(games, cfg.sxLeagueId).catch(() => EMPTY_SX) : EMPTY_SX;
      const sxDynML = cfg.sxDynamic ? await fetchSxBetMoneylineByGame(games, cfg.sxDynamic).catch(emptyTwo) : emptyTwo();
      const sxDynTotals =
        cfg.sxDynamic?.totals && cfg.markets.totals
          ? await fetchSxBetTotalsByGame(games, cfg.sxDynamic).catch(emptyTot)
          : emptyTot();
      // predict.fun (MLB moneyline) + CloudBet (moneyline; 2-way, or 3-way soccer 1X2).
      const pfML = cfg.predictfun ? await fetchPredictFunMoneylineByGame(games).catch(emptyTwo) : emptyTwo();
      const cbML = cfg.cloudbet ? await fetchCloudbetMoneylineByGame(games, cfg.cloudbet).catch(emptyTwo) : emptyTwo();
      const cbTot =
        cfg.cloudbet && cfg.cloudbet.totals && cfg.markets.totals
          ? await fetchCloudbetTotalsByGame(games, cfg.cloudbet).catch(emptyTot)
          : emptyTot();
      const cbSp =
        cfg.cloudbet && cfg.cloudbet.spread && cfg.markets.spread
          ? await fetchCloudbetSpreadByGame(games, cfg.cloudbet).catch(emptySpread)
          : emptySpread();

      const now = new Date().toISOString();
      for (const game of games) {
        const kRows = [
          ...normalizeVenueTotals("kalshi", game, kTot.get(game.id), cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("kalshi", game, kML.get(game.id), "moneyline", cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("kalshi", game, kSp.get(game.id), "spread", cfg.sport, cfg.league, now),
        ];
        const pRows = [
          ...normalizeVenueTotals("polymarket", game, pTot.get(game.id), cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("polymarket", game, pML.get(game.id), "moneyline", cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("polymarket", game, pSp.get(game.id), "spread", cfg.sport, cfg.league, now),
        ];
        const sxMoneyline = cfg.sxDynamic ? sxDynML.get(game.id) : sx.moneyline.get(game.id);
        const sRows = [
          ...normalizeVenueTotals("sxbet", game, cfg.sxDynamic?.totals ? sxDynTotals.get(game.id) : sx.totals.get(game.id), cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("sxbet", game, sxMoneyline, "moneyline", cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("sxbet", game, sx.spread.get(game.id), "spread", cfg.sport, cfg.league, now),
        ];
        // predict.fun + CloudBet: moneyline only.
        const pfRows = normalizeVenueTwoWay("predictfun", game, pfML.get(game.id), "moneyline", cfg.sport, cfg.league, now);
        const cbRows = [
          ...normalizeVenueTwoWay("cloudbet", game, cbML.get(game.id), "moneyline", cfg.sport, cfg.league, now),
          ...normalizeVenueTotals("cloudbet", game, cbTot.get(game.id), cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("cloudbet", game, cbSp.get(game.id), "spread", cfg.sport, cfg.league, now),
        ];
        venueCounts.kalshi += kRows.length;
        venueCounts.polymarket += pRows.length;
        venueCounts.sxbet += sRows.length;
        venueCounts.predictfun += pfRows.length;
        venueCounts.cloudbet += cbRows.length;
        markets.push(...kRows, ...pRows, ...sRows, ...pfRows, ...cbRows);
      }
    })
  );

  await saveMarkets(date, markets);
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
export async function refreshMarketsForOpportunity(date: string, opportunityId: string): Promise<NormalizedMarket[]> {
  const current = await getMarkets(date);
  const eventKey = opportunityEventKey(opportunityId);
  if (!eventKey) return current;

  const eventMarkets = current.filter((m) => buildEventKey(m) === eventKey);
  const seed = eventMarkets[0];
  const gameId = seed ? marketGameId(seed) : null;
  if (!seed || !gameId) return current;

  const cfg = SPORTS.find((s) => s.sport === seed.sport && s.league === seed.league);
  if (!cfg) return current;

  const games = await cfg.fetchGames(date).catch((e) => {
    console.error(`[arbitrage/ingest] targeted ${cfg.league} games fetch failed:`, e);
    return [];
  });
  const game = games.find((g) => g.id === gameId);
  if (!game) return current;

  const fresh = await ingestSportMarkets(cfg, [game]);
  if (!fresh.markets.length) return current;

  const merged = current.filter((m) => !(m.sport === seed.sport && m.league === seed.league && marketGameId(m) === gameId));
  merged.push(...fresh.markets);
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
