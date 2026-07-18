// Polymarket US venue adapter (read-only). Polymarket US is the regulated US product
// (api.polymarket.us / gateway.polymarket.us) — a CENTRAL limit order book, unlike the
// international self-custody CLOB. Market data is on the PUBLIC gateway (no auth). We
// pull today's MLB game markets and normalize them into the same VenueTwoWay /
// VenueSpread / VenueTotalLine shapes as Kalshi so the matching + arb engines treat it
// as another venue.
//
// MLB market types (sportsMarketType): baseball_team_full_game_winner (moneyline),
// baseball_team_full_game_total (over/under), baseball_team_full_game_spread (run line).
// Each market has a "long" side and a "short" side. Executable prices come from
// /v1/markets/{slug}/bbo: longQuote = ask to BUY the long side, shortQuote = ask to BUY
// the short side (they sum to ~1 + vig). Long = Over / first team ⇒ YES; short ⇒ NO,
// which maps onto our Kalshi-style yes/no order model. The market `slug` is the native
// id used to place an order (create-order marketSlug).
//
// One fetch pulls all three market types: events are fetched ONCE and each market's BBO
// ONCE (deduped), so a scan re-poll stays fast enough for a tight arbitrage loop.

import type { VenueSpread, VenueTotalLine, VenueTwoWay } from "./kalshi";
import type { ArbGame } from "./arbitrage/sports";
import { teamsMatch } from "./teamNormalization";

const GATEWAY = "https://gateway.polymarket.us";

const T_MONEYLINE = "baseball_team_full_game_winner";
const T_TOTAL = "baseball_team_full_game_total";
const T_SPREAD = "baseball_team_full_game_spread";

type PmTeam = { name: string; abbreviation: string };
type PmMarketSide = {
  id: string;
  description: string; // "Over" | "Under" | team name
  long: boolean;
  price?: string;
  team?: { abbreviation?: string; name?: string; league?: string };
};
type PmMarket = {
  id: string;
  slug: string;
  sportsMarketType?: string;
  line?: number;
  closed?: boolean;
  feeCoefficient?: number;
  marketSides?: PmMarketSide[];
};
type PmEvent = { id: string; title: string; gameId?: string; startTime?: string; teams?: PmTeam[]; markets?: PmMarket[] };

type Amount = { value?: string; currency?: string };
type MarketData = { longQuote?: Amount; shortQuote?: Amount; bestAsk?: Amount; bestBid?: Amount; askDepth?: number; bidDepth?: number };

export type PolymarketUsMarkets = {
  moneyline: Map<string, VenueTwoWay>;
  spread: Map<string, VenueSpread>;
  totals: Map<string, VenueTotalLine[]>;
};

// ── Public gateway fetch (no auth) ─────────────────────────────────────────────
async function fetchMlbEvents(): Promise<PmEvent[]> {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${GATEWAY}/v1/events?tagSlug=mlb&startDateMin=${today}T00:00:00Z&limit=100`;
  try {
    const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!r.ok) return [];
    const j = (await r.json()) as { events?: PmEvent[] };
    return j.events ?? [];
  } catch (e) {
    console.error("[polymarket-us] events fetch failed:", e);
    return [];
  }
}

async function fetchBbo(slug: string): Promise<MarketData | null> {
  try {
    const r = await fetch(`${GATEWAY}/v1/markets/${slug}/bbo`, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const j = (await r.json()) as { marketData?: MarketData };
    return j.marketData ?? null;
  } catch {
    return null;
  }
}

const cents = (a?: Amount): number | null => {
  const n = Number(a?.value);
  return Number.isFinite(n) && n > 0 && n < 1 ? Number((n * 100).toFixed(4)) : null;
};

function eventMatchesGame(ev: PmEvent, game: ArbGame): boolean {
  // A head-to-head game event has EXACTLY two teams. Futures (e.g. "World Series
  // Champion") list many contenders and would spuriously match both sides.
  const teams = ev.teams ?? [];
  if (teams.length !== 2) return false;
  const names = teams.map((t) => t.name).filter(Boolean);
  const homeHit = names.some((n) => teamsMatch(n, game.homeTeam.name) || n.toLowerCase().includes(game.homeTeam.abbreviation.toLowerCase()));
  const awayHit = names.some((n) => teamsMatch(n, game.awayTeam.name) || n.toLowerCase().includes(game.awayTeam.abbreviation.toLowerCase()));
  return homeHit && awayHit;
}

function longShort(m: PmMarket): { long: PmMarketSide; short: PmMarketSide } | null {
  const long = (m.marketSides ?? []).find((s) => s.long);
  const short = (m.marketSides ?? []).find((s) => !s.long);
  return long && short ? { long, short } : null;
}

function teamIsHome(side: PmMarketSide, game: ArbGame): boolean {
  const n = side.team?.name ?? side.description;
  const ab = side.team?.abbreviation ?? "";
  return (
    teamsMatch(n, game.homeTeam.name) ||
    ab.toLowerCase() === game.homeTeam.abbreviation.toLowerCase() ||
    n.toLowerCase().includes(game.homeTeam.abbreviation.toLowerCase())
  );
}

// Fetch + normalize all Polymarket US MLB markets for the given games in ONE pass:
// events once, each market's BBO once. Mirrors fetchSxBetMLBMarkets' shape.
export async function fetchPolymarketUsMLBMarkets(games: ArbGame[]): Promise<PolymarketUsMarkets> {
  const result: PolymarketUsMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };
  if (!games.length) return result;

  const events = await fetchMlbEvents();

  // Collect every market we care about across all matched games, then fetch each unique
  // slug's BBO exactly once.
  type Job = { game: ArbGame; market: PmMarket };
  const jobs: Job[] = [];
  const matched = new Map<string, PmEvent>();
  for (const game of games) {
    const ev = events.find((e) => eventMatchesGame(e, game));
    if (!ev) continue;
    matched.set(game.id, ev);
    for (const m of ev.markets ?? []) {
      if (m.closed) continue;
      if ([T_MONEYLINE, T_TOTAL, T_SPREAD].includes(m.sportsMarketType ?? "")) jobs.push({ game, market: m });
    }
  }
  const slugs = [...new Set(jobs.map((j) => j.market.slug))];
  const bboEntries = await Promise.all(slugs.map(async (slug) => [slug, await fetchBbo(slug)] as const));
  const bboBySlug = new Map<string, MarketData | null>(bboEntries);

  for (const game of games) {
    if (!matched.has(game.id)) continue;
    const gameJobs = jobs.filter((j) => j.game.id === game.id);

    // Moneyline
    const mlJob = gameJobs.find((j) => j.market.sportsMarketType === T_MONEYLINE);
    if (mlJob) {
      const ls = longShort(mlJob.market);
      const bbo = bboBySlug.get(mlJob.market.slug);
      const longAsk = cents(bbo?.longQuote);
      const shortAsk = cents(bbo?.shortQuote);
      if (ls && longAsk != null && shortAsk != null) {
        const longIsHome = teamIsHome(ls.long, game);
        const longLiq = (bbo?.askDepth ?? 0) * (longAsk / 100);
        const shortLiq = (bbo?.bidDepth ?? 0) * (shortAsk / 100);
        result.moneyline.set(game.id, {
          homeCents: longIsHome ? longAsk : shortAsk,
          awayCents: longIsHome ? shortAsk : longAsk,
          homeLiquidityUsd: longIsHome ? longLiq : shortLiq,
          awayLiquidityUsd: longIsHome ? shortLiq : longLiq,
          marketId: mlJob.market.slug,
          yesSide: longIsHome ? "home" : "away",
        });
      }
    }

    // Totals (possibly several lines)
    const totalRows: VenueTotalLine[] = [];
    for (const j of gameJobs.filter((x) => x.market.sportsMarketType === T_TOTAL && x.market.line != null)) {
      const ls = longShort(j.market);
      const bbo = bboBySlug.get(j.market.slug);
      const overAsk = cents(bbo?.longQuote); // long side = Over
      const underAsk = cents(bbo?.shortQuote);
      if (!ls || overAsk == null || underAsk == null) continue;
      totalRows.push({
        line: j.market.line as number,
        overCents: overAsk,
        underCents: underAsk,
        overLiquidityUsd: (bbo?.askDepth ?? 0) * (overAsk / 100),
        underLiquidityUsd: (bbo?.bidDepth ?? 0) * (underAsk / 100),
        marketId: j.market.slug,
      });
    }
    if (totalRows.length) result.totals.set(game.id, totalRows);

    // Spread — prefer the main ±1.5 run line
    const spreads = gameJobs.filter((x) => x.market.sportsMarketType === T_SPREAD);
    const spJob = spreads.find((x) => Math.abs(x.market.line ?? 0) === 1.5) ?? spreads[0];
    if (spJob) {
      const ls = longShort(spJob.market);
      const bbo = bboBySlug.get(spJob.market.slug);
      const longAsk = cents(bbo?.longQuote);
      const shortAsk = cents(bbo?.shortQuote);
      if (ls && longAsk != null && shortAsk != null) {
        const longIsHome = teamIsHome(ls.long, game);
        const lineMag = Math.abs(spJob.market.line ?? 1.5);
        result.spread.set(game.id, {
          homeCents: longIsHome ? longAsk : shortAsk,
          awayCents: longIsHome ? shortAsk : longAsk,
          homeLiquidityUsd: (bbo?.askDepth ?? 0) * (longAsk / 100),
          awayLiquidityUsd: (bbo?.bidDepth ?? 0) * (shortAsk / 100),
          homeSignedLine: longIsHome ? -lineMag : lineMag,
          marketId: spJob.market.slug,
          yesSide: longIsHome ? "home" : "away",
        });
      }
    }
  }

  return result;
}
