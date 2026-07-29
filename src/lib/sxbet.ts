// SX.bet venue adapter (read-only, manual §7). SX.bet is an order-book betting
// exchange; taker prices come from resting maker orders. We fetch MLB markets +
// their order books and normalize into the same VenueTwoWay / VenueSpread /
// VenueTotalLine shapes as Kalshi/Polymarket, keyed by ESPN gameId so the matching
// engine treats it as a third venue automatically.
//
// Market types: 226 = moneyline, 28 = total (over/under), 342 = run-line spread.
// Odds: order.percentageOdds is the maker's implied prob (×1e20). A taker filling a
// maker order takes the OPPOSITE outcome at (1 - makerProb).

import { teamsMatch } from "./teamNormalization";
import type { VenueSpread, VenueTotalLine, VenueTwoWay } from "./kalshi";
import type { ArbGame } from "./arbitrage/sports";

const SX_API = "https://api.sx.bet";
const TYPE_MONEYLINE = 226; // baseball/basketball 2-way moneyline
const TYPE_TOTAL = 28;
const TYPE_SPREAD = 342;
const TYPE_TEAM_YESNO = 1; // "X vs Not X" — soccer 1X2 is three of these (home / away / Tie)
const TYPE_TWO_WAY = 52; // 2-way "team1 vs team2" (soccer draw-no-bet; used for tennis winner)
const USDC_DECIMALS = 1e6; // SX.bet collateral is USDC (6 decimals)

type SxMarket = {
  marketHash: string;
  type: number;
  line: number | null;
  outcomeOneName: string;
  outcomeTwoName: string;
  teamOneName: string;
  teamTwoName: string;
  gameTime: number;
};

type SxOrder = {
  marketHash: string;
  percentageOdds: string;
  totalBetSize: string;
  fillAmount: string;
  isMakerBettingOutcomeOne: boolean;
};

// Best taker price + liquidity for each side of a market's order book.
type BookPrices = { o1Cents: number; o2Cents: number; o1LiqUsd: number; o2LiqUsd: number };

function bestPrices(orders: SxOrder[] | undefined): BookPrices | null {
  if (!orders?.length) return null;
  // Makers betting outcome TWO let a taker BUY outcome ONE, and vice versa.
  let bestPforO1 = 0;
  let o1Liq = 0;
  let bestPforO2 = 0;
  let o2Liq = 0;
  for (const o of orders) {
    const avail = Number(o.totalBetSize) - Number(o.fillAmount);
    if (avail <= 0) continue;
    const p = Number(o.percentageOdds) / 1e20;
    if (p <= 0 || p >= 1) continue;
    if (!o.isMakerBettingOutcomeOne) {
      if (p > bestPforO1) {
        bestPforO1 = p;
        o1Liq = avail;
      }
    } else if (p > bestPforO2) {
      bestPforO2 = p;
      o2Liq = avail;
    }
  }
  if (bestPforO1 === 0 || bestPforO2 === 0) return null; // one-sided book
  return {
    o1Cents: Number(((1 - bestPforO1) * 100).toFixed(4)),
    o2Cents: Number(((1 - bestPforO2) * 100).toFixed(4)),
    o1LiqUsd: o1Liq / USDC_DECIMALS,
    o2LiqUsd: o2Liq / USDC_DECIMALS,
  };
}

async function fetchActiveMarkets(leagueId: number, onlyMainLine = true): Promise<SxMarket[]> {
  try {
    const res = await fetch(`${SX_API}/markets/active?leagueId=${leagueId}${onlyMainLine ? "&onlyMainLine=true" : ""}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data?.markets ?? []) as SxMarket[];
  } catch (e) {
    console.error("[sxbet] markets fetch failed:", e);
    return [];
  }
}

type SxLeague = { leagueId: number; label: string; sportId: number; active: boolean };

async function fetchLeagues(): Promise<SxLeague[]> {
  try {
    const res = await fetch(`${SX_API}/leagues`, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    return ((await res.json())?.data ?? []) as SxLeague[];
  } catch (e) {
    console.error("[sxbet] leagues fetch failed:", e);
    return [];
  }
}

async function fetchOrders(hashes: string[]): Promise<Map<string, SxOrder[]>> {
  const map = new Map<string, SxOrder[]>();
  for (let i = 0; i < hashes.length; i += 20) {
    const chunk = hashes.slice(i, i + 20);
    try {
      const res = await fetch(`${SX_API}/orders?marketHashes=${chunk.join(",")}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const o of (data?.data ?? []) as SxOrder[]) {
        (map.get(o.marketHash) ?? map.set(o.marketHash, []).get(o.marketHash)!).push(o);
      }
    } catch (e) {
      console.error("[sxbet] orders fetch failed:", e);
    }
  }
  return map;
}

function teamHit(name: string, team: { name: string; abbreviation: string }): boolean {
  return teamsMatch(name, team.name) || name.toLowerCase().includes(team.abbreviation.toLowerCase());
}

function sxGameDate(m: SxMarket): string | null {
  if (!Number.isFinite(m.gameTime)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(m.gameTime * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// A market matches a game when its two teams equal the game's away/home in either order.
function marketMatchesGame(m: SxMarket, game: ArbGame): boolean {
  const { awayTeam: a, homeTeam: h } = game;
  return (
    (teamHit(m.teamOneName, a) && teamHit(m.teamTwoName, h)) ||
    (teamHit(m.teamOneName, h) && teamHit(m.teamTwoName, a))
  );
}

function marketMatchesGameDate(m: SxMarket, game: ArbGame): boolean {
  return marketMatchesGame(m, game) && sxGameDate(m) === game.date;
}

export type SxBetMarkets = {
  moneyline: Map<string, VenueTwoWay>;
  spread: Map<string, VenueSpread>;
  totals: Map<string, VenueTotalLine[]>;
};

function collectTotalsByGame(
  games: ArbGame[],
  markets: SxMarket[],
  books: Map<string, SxOrder[]>
): Map<string, VenueTotalLine[]> {
  const out = new Map<string, VenueTotalLine[]>();
  for (const game of games) {
    const totalRows: VenueTotalLine[] = [];
    for (const t of markets.filter((m) => m.type === TYPE_TOTAL && marketMatchesGameDate(m, game))) {
      const bp = bestPrices(books.get(t.marketHash));
      if (!bp || t.line == null) continue;
      const overIsOne = t.outcomeOneName.toLowerCase().startsWith("over");
      const sourceStartTime = sxGameDate(t) ?? game.date;
      totalRows.push({
        line: t.line,
        overCents: overIsOne ? bp.o1Cents : bp.o2Cents,
        underCents: overIsOne ? bp.o2Cents : bp.o1Cents,
        overLiquidityUsd: overIsOne ? bp.o1LiqUsd : bp.o2LiqUsd,
        underLiquidityUsd: overIsOne ? bp.o2LiqUsd : bp.o1LiqUsd,
        marketId: t.marketHash,
        overIsOutcomeOne: overIsOne,
        sourceStartTime,
      });
    }
    if (totalRows.length) out.set(game.id, totalRows);
  }
  return out;
}

// Fetch + normalize all SX.bet markets for the given league + ESPN games.
export async function fetchSxBetMLBMarkets(games: ArbGame[], leagueId: number = 171): Promise<SxBetMarkets> {
  const result: SxBetMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };
  if (!games.length) return result;

  const markets = await fetchActiveMarkets(leagueId);
  const relevant = markets.filter((m) => [TYPE_MONEYLINE, TYPE_TOTAL, TYPE_SPREAD].includes(m.type));
  if (!relevant.length) return result;

  const books = await fetchOrders(relevant.map((m) => m.marketHash));

  for (const game of games) {
    const gm = relevant.filter((m) => marketMatchesGameDate(m, game));
    if (!gm.length) continue;

    // Moneyline (226): team names → home/away.
    const ml = gm.find((m) => m.type === TYPE_MONEYLINE);
    if (ml) {
      const bp = bestPrices(books.get(ml.marketHash));
      if (bp) {
        const oneIsAway = teamHit(ml.teamOneName, game.awayTeam);
        result.moneyline.set(game.id, {
          awayCents: oneIsAway ? bp.o1Cents : bp.o2Cents,
          homeCents: oneIsAway ? bp.o2Cents : bp.o1Cents,
          awayLiquidityUsd: oneIsAway ? bp.o1LiqUsd : bp.o2LiqUsd,
          homeLiquidityUsd: oneIsAway ? bp.o2LiqUsd : bp.o1LiqUsd,
          marketId: ml.marketHash,
          homeIsOutcomeOne: !oneIsAway,
          sourceStartTime: sxGameDate(ml) ?? game.date,
        });
      }
    }

    // Spread (342): "Team +1.5 / Team -1.5" → home/away cover + signed home line.
    const sp = gm.find((m) => m.type === TYPE_SPREAD);
    if (sp) {
      const bp = bestPrices(books.get(sp.marketHash));
      if (bp) {
        const oneIsHome = teamHit(sp.teamOneName, game.homeTeam);
        const homeOutcomeName = oneIsHome ? sp.outcomeOneName : sp.outcomeTwoName;
        const homeSignedLine = homeOutcomeName.includes("-1.5") ? -1.5 : 1.5;
        result.spread.set(game.id, {
          homeCents: oneIsHome ? bp.o1Cents : bp.o2Cents,
          awayCents: oneIsHome ? bp.o2Cents : bp.o1Cents,
          homeLiquidityUsd: oneIsHome ? bp.o1LiqUsd : bp.o2LiqUsd,
          awayLiquidityUsd: oneIsHome ? bp.o2LiqUsd : bp.o1LiqUsd,
          homeSignedLine,
          marketId: sp.marketHash,
          homeIsOutcomeOne: oneIsHome,
          sourceStartTime: sxGameDate(sp) ?? game.date,
        });
      }
    }

    // Totals (28): "Over N / Under N". SX often uses integer lines (push on exact),
    // which won't match Kalshi/Polymarket .5 lines — that's fine, the matcher drops
    // non-equal lines. We still ingest them for completeness.
    const totalRows = collectTotalsByGame([game], gm, books).get(game.id);
    if (totalRows?.length) result.totals.set(game.id, totalRows);
  }

  return result;
}

// SX.bet has NO native 3-selection market, so soccer 1X2 is three "type 1" (X vs Not X)
// markets — backing outcome ONE of the home-team, away-team, and "Tie" markets yields the
// home/away/draw prices (validated live: home+away+tie ≈ 102¢ overround). Tennis is a
// plain 2-way winner (type 226/52). Leagues are enumerated live by sportId + label because
// SX uses ephemeral per-tournament league ids (a new WTA league per event).
export async function fetchSxBetMoneylineByGame(
  games: ArbGame[],
  opts: { sportId: number; leagueMatch: RegExp; threeWay?: boolean }
): Promise<Map<string, VenueTwoWay>> {
  const out = new Map<string, VenueTwoWay>();
  if (!games.length) return out;

  const leagues = await fetchLeagues();
  const leagueIds = leagues
    .filter((l) => l.active && l.sportId === opts.sportId && opts.leagueMatch.test(l.label))
    .map((l) => l.leagueId);
  if (!leagueIds.length) return out;

  // Fetch across the matched leagues (cap to bound the request count).
  const markets: SxMarket[] = [];
  for (const id of leagueIds.slice(0, 96)) markets.push(...(await fetchActiveMarkets(id, false)));
  if (!markets.length) return out;

  const books = await fetchOrders([...new Set(markets.map((m) => m.marketHash))]);

  for (const game of games) {
    const gm = markets.filter((m) => marketMatchesGameDate(m, game));
    if (!gm.length) continue;

    if (opts.threeWay) {
      // Three "type 1" markets for this game: outcomeOne = home team / away team / Tie.
      const t1 = gm.filter((m) => m.type === TYPE_TEAM_YESNO && !/^not\b/i.test(m.outcomeOneName));
      const homeMkt = t1.find((m) => teamHit(m.outcomeOneName, game.homeTeam));
      const awayMkt = t1.find((m) => teamHit(m.outcomeOneName, game.awayTeam));
      const tieMkt = t1.find((m) => /^(tie|draw)\b/i.test(m.outcomeOneName));
      const hp = homeMkt && bestPrices(books.get(homeMkt.marketHash));
      const ap = awayMkt && bestPrices(books.get(awayMkt.marketHash));
      const tp = tieMkt && bestPrices(books.get(tieMkt.marketHash));
      if (homeMkt && awayMkt && tieMkt && hp && ap && tp) {
        out.set(game.id, {
          // Back outcome ONE of each market = buy that result.
          homeCents: hp.o1Cents,
          awayCents: ap.o1Cents,
          drawCents: tp.o1Cents,
          homeLiquidityUsd: hp.o1LiqUsd,
          awayLiquidityUsd: ap.o1LiqUsd,
          drawLiquidityUsd: tp.o1LiqUsd,
          marketId: homeMkt.marketHash,
          homeTokenId: homeMkt.marketHash,
          awayTokenId: awayMkt.marketHash,
          drawTokenId: tieMkt.marketHash,
          sourceStartTime: sxGameDate(homeMkt) ?? game.date,
        });
      }
      continue;
    }

    // Tennis: a plain 2-way winner market whose two outcomes are the two players.
    const mw =
      gm.find((m) => (m.type === TYPE_MONEYLINE || m.type === TYPE_TWO_WAY) && teamHit(m.teamOneName, game.awayTeam) && teamHit(m.teamTwoName, game.homeTeam)) ??
      gm.find((m) => (m.type === TYPE_MONEYLINE || m.type === TYPE_TWO_WAY) && teamHit(m.teamOneName, game.homeTeam) && teamHit(m.teamTwoName, game.awayTeam));
    if (!mw) continue;
    const bp = bestPrices(books.get(mw.marketHash));
    if (!bp) continue;
    const oneIsAway = teamHit(mw.teamOneName, game.awayTeam);
    out.set(game.id, {
      awayCents: oneIsAway ? bp.o1Cents : bp.o2Cents,
      homeCents: oneIsAway ? bp.o2Cents : bp.o1Cents,
      awayLiquidityUsd: oneIsAway ? bp.o1LiqUsd : bp.o2LiqUsd,
      homeLiquidityUsd: oneIsAway ? bp.o2LiqUsd : bp.o1LiqUsd,
      marketId: mw.marketHash,
      homeIsOutcomeOne: !oneIsAway,
      sourceStartTime: sxGameDate(mw) ?? game.date,
    });
  }
  return out;
}

export async function fetchSxBetTotalsByGame(
  games: ArbGame[],
  opts: { sportId: number; leagueMatch: RegExp }
): Promise<Map<string, VenueTotalLine[]>> {
  if (!games.length) return new Map();

  const leagues = await fetchLeagues();
  const leagueIds = leagues
    .filter((l) => l.active && l.sportId === opts.sportId && opts.leagueMatch.test(l.label))
    .map((l) => l.leagueId);
  if (!leagueIds.length) return new Map();

  const markets: SxMarket[] = [];
  for (const id of leagueIds.slice(0, 96)) {
    markets.push(...(await fetchActiveMarkets(id, false)));
  }
  const relevant = markets.filter((m) => m.type === TYPE_TOTAL);
  if (!relevant.length) return new Map();

  const books = await fetchOrders([...new Set(relevant.map((m) => m.marketHash))]);
  return collectTotalsByGame(games, relevant, books);
}
