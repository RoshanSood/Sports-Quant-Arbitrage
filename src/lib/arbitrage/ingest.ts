// Ingestion: for each configured sport, fetch games + Kalshi/Polymarket/SX.bet
// markets (totals / moneyline / spread), normalize into the shared NormalizedMarket
// model, and persist. The matching + arb engines key events by sport:league:teams,
// so every configured league shares one pipeline without cross-matching.

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
} from "@/lib/polymarket";
import { fetchSxBetMLBMarkets, type SxBetMarkets } from "@/lib/sxbet";
import type { NormalizedMarket, Outcome, Sport, VenueId } from "@/types/arbitrage";
import { decimalOddsFromCents, impliedProbFromCents } from "./arbMath";
import { saveMarkets, setRunning } from "./marketStore";
import { isEligibleArbGame, SPORTS, type ArbGame } from "./sports";

const EMPTY_SX: SxBetMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };

// The venue-native side identifier a live order needs for a given outcome:
//   • Kalshi     → "yes" | "no"
//   • Polymarket → the ERC-1155 CLOB token id for that outcome
//   • SX.bet     → "one" | "two" (isTakerBettingOutcomeOne)
// Undefined when the venue hasn't supplied the id (read-only rows still ingest fine).
function nativeSideFor(
  venueId: VenueId,
  ids: { kalshiYesNo: "yes" | "no"; polyTokenId?: string; sxIsOne?: boolean }
): string | undefined {
  if (venueId === "kalshi") return ids.kalshiYesNo;
  if (venueId === "polymarket") return ids.polyTokenId;
  if (venueId === "sxbet") return ids.sxIsOne === undefined ? undefined : ids.sxIsOne ? "one" : "two";
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
        sport,
        league,
        startTime: game.startTimeIso || game.date,
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
  for (const [outcome, priceCents, liqUsd, tokenId, sxIsOne] of [
    ["home", q.homeCents, q.homeLiquidityUsd, q.homeTokenId, q.homeIsOutcomeOne] as const,
    ["away", q.awayCents, q.awayLiquidityUsd, q.awayTokenId, q.homeIsOutcomeOne === undefined ? undefined : !q.homeIsOutcomeOne] as const,
  ]) {
    if (priceCents <= 0 || priceCents >= 100) continue;
    const liquidityUsd = Number.isFinite(liqUsd) ? Math.round(liqUsd) : 0;
    rows.push({
      venueId,
      marketId: `${venueId}:${game.id}:${marketType}:${lineKey}:${outcome}`,
      // Kalshi two-way: buy YES on the team the market's YES side represents, else NO.
      nativeMarketId: q.marketId,
      nativeSide: nativeSideFor(venueId, {
        kalshiYesNo: q.yesSide && outcome === q.yesSide ? "yes" : "no",
        polyTokenId: tokenId,
        sxIsOne,
      }),
      sport,
      league,
      startTime: game.startTimeIso || game.date,
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

// Ingest all configured sports for a date. Public market reads — no credentials.
export async function ingestTotals(date: string): Promise<IngestResult> {
  const now = new Date().toISOString();
  const markets: NormalizedMarket[] = [];
  const venueCounts: Record<VenueId, number> = { kalshi: 0, polymarket: 0, sxbet: 0 };
  let gameCount = 0;

  await Promise.all(
    SPORTS.map(async (cfg) => {
      const fetchedGames: ArbGame[] = await cfg.fetchGames(date).catch((e) => {
        console.error(`[arbitrage/ingest] ${cfg.league} games fetch failed:`, e);
        return [];
      });
      const games = fetchedGames.filter(isEligibleArbGame);
      gameCount += games.length;
      if (!games.length) return;

      const [kTot, pTot, kML, pML, kSp, pSp, sx] = await Promise.all([
        fetchKalshiTotalsByGame(games, cfg.kalshi.total, cfg.league).catch(() => new Map<string, VenueTotalLine[]>()),
        cfg.polyTag
          ? fetchPolymarketTotalsByGame(games, cfg.polyTag).catch(() => new Map<string, VenueTotalLine[]>())
          : Promise.resolve(new Map<string, VenueTotalLine[]>()),
        fetchKalshiMoneylineByGame(games, cfg.kalshi.game, cfg.league).catch(() => new Map<string, VenueTwoWay>()),
        cfg.polyTag
          ? fetchPolymarketMoneylineByGame(games, cfg.polyTag).catch(() => new Map<string, VenueTwoWay>())
          : Promise.resolve(new Map<string, VenueTwoWay>()),
        fetchKalshiSpreadByGame(games, cfg.kalshi.spread, cfg.spreadFixedLine, cfg.league).catch(() => new Map<string, VenueSpread>()),
        cfg.polyTag
          ? fetchPolymarketSpreadByGame(games, cfg.polyTag).catch(() => new Map<string, VenueSpread>())
          : Promise.resolve(new Map<string, VenueSpread>()),
        fetchSxBetMLBMarkets(games, cfg.sxLeagueId, cfg.league).catch(() => EMPTY_SX),
      ]);

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
        const sRows = [
          ...normalizeVenueTotals("sxbet", game, sx.totals.get(game.id), cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("sxbet", game, sx.moneyline.get(game.id), "moneyline", cfg.sport, cfg.league, now),
          ...normalizeVenueTwoWay("sxbet", game, sx.spread.get(game.id), "spread", cfg.sport, cfg.league, now),
        ];
        venueCounts.kalshi += kRows.length;
        venueCounts.polymarket += pRows.length;
        venueCounts.sxbet += sRows.length;
        markets.push(...kRows, ...pRows, ...sRows);
      }
    })
  );

  await saveMarkets(date, markets);
  return { date, gameCount, markets, venueCounts };
}

// Fire-and-forget wrapper used by the run route; manages the running flag.
export async function runIngestion(date: string): Promise<void> {
  setRunning(date, true);
  try {
    const r = await ingestTotals(date);
    console.log(
      `[arbitrage/ingest] ${date}: ${r.gameCount} games, ` +
        `${r.venueCounts.kalshi} Kalshi + ${r.venueCounts.polymarket} Polymarket + ${r.venueCounts.sxbet} SX.bet quotes`
    );
  } catch (e) {
    console.error(`[arbitrage/ingest] ${date} failed:`, e);
  } finally {
    setRunning(date, false);
  }
}
