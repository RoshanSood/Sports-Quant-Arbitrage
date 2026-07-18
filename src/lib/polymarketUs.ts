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

// Build one game's matched event → find its markets, fetch BBO, normalize. Returns the
// three shapes keyed later by the caller.
async function eventFor(game: ArbGame, events: PmEvent[]): Promise<PmEvent | null> {
  return events.find((ev) => eventMatchesGame(ev, game)) ?? null;
}

export async function fetchPolymarketUsMoneylineByGame(games: ArbGame[]): Promise<Map<string, VenueTwoWay>> {
  const out = new Map<string, VenueTwoWay>();
  if (!games.length) return out;
  const events = await fetchMlbEvents();
  await Promise.all(
    games.map(async (game) => {
      const ev = await eventFor(game, events);
      const m = ev?.markets?.find((x) => x.sportsMarketType === T_MONEYLINE && !x.closed);
      const ls = m ? longShort(m) : null;
      if (!m || !ls) return;
      const bbo = await fetchBbo(m.slug);
      const longAsk = cents(bbo?.longQuote);
      const shortAsk = cents(bbo?.shortQuote);
      if (longAsk == null || shortAsk == null) return;
      const longIsHome = teamIsHome(ls.long, game);
      const longLiq = (bbo?.askDepth ?? 0) * (longAsk / 100);
      const shortLiq = (bbo?.bidDepth ?? 0) * (shortAsk / 100);
      out.set(game.id, {
        homeCents: longIsHome ? longAsk : shortAsk,
        awayCents: longIsHome ? shortAsk : longAsk,
        homeLiquidityUsd: longIsHome ? longLiq : shortLiq,
        awayLiquidityUsd: longIsHome ? shortLiq : longLiq,
        marketId: m.slug,
        // Long side = YES. Whichever of home/away is the long side is the venue's YES.
        yesSide: longIsHome ? "home" : "away",
      });
    })
  );
  return out;
}

export async function fetchPolymarketUsTotalsByGame(games: ArbGame[]): Promise<Map<string, VenueTotalLine[]>> {
  const out = new Map<string, VenueTotalLine[]>();
  if (!games.length) return out;
  const events = await fetchMlbEvents();
  await Promise.all(
    games.map(async (game) => {
      const ev = await eventFor(game, events);
      const totals = (ev?.markets ?? []).filter((x) => x.sportsMarketType === T_TOTAL && !x.closed && x.line != null);
      if (!totals.length) return;
      const rows: VenueTotalLine[] = [];
      await Promise.all(
        totals.map(async (m) => {
          const ls = longShort(m);
          if (!ls) return;
          const bbo = await fetchBbo(m.slug);
          // Long side is "Over", short is "Under".
          const overAsk = cents(bbo?.longQuote);
          const underAsk = cents(bbo?.shortQuote);
          if (overAsk == null || underAsk == null) return;
          rows.push({
            line: m.line as number,
            overCents: overAsk,
            underCents: underAsk,
            overLiquidityUsd: (bbo?.askDepth ?? 0) * (overAsk / 100),
            underLiquidityUsd: (bbo?.bidDepth ?? 0) * (underAsk / 100),
            marketId: m.slug,
          });
        })
      );
      if (rows.length) out.set(game.id, rows);
    })
  );
  return out;
}

export async function fetchPolymarketUsSpreadByGame(games: ArbGame[]): Promise<Map<string, VenueSpread>> {
  const out = new Map<string, VenueSpread>();
  if (!games.length) return out;
  const events = await fetchMlbEvents();
  await Promise.all(
    games.map(async (game) => {
      // Prefer the main -1.5 / +1.5 run line.
      const spreads = (await eventFor(game, events))?.markets?.filter((x) => x.sportsMarketType === T_SPREAD && !x.closed) ?? [];
      const m = spreads.find((x) => Math.abs(x.line ?? 0) === 1.5) ?? spreads[0];
      const ls = m ? longShort(m) : null;
      if (!m || !ls) return;
      const bbo = await fetchBbo(m.slug);
      const longAsk = cents(bbo?.longQuote);
      const shortAsk = cents(bbo?.shortQuote);
      if (longAsk == null || shortAsk == null) return;
      const longIsHome = teamIsHome(ls.long, game);
      const lineMag = Math.abs(m.line ?? 1.5);
      // Signed home line: negative when home is favored (home is the long/-1.5 side).
      const homeSignedLine = longIsHome ? -lineMag : lineMag;
      out.set(game.id, {
        homeCents: longIsHome ? longAsk : shortAsk,
        awayCents: longIsHome ? shortAsk : longAsk,
        homeLiquidityUsd: (bbo?.askDepth ?? 0) * (longAsk / 100),
        awayLiquidityUsd: (bbo?.bidDepth ?? 0) * (shortAsk / 100),
        homeSignedLine,
        marketId: m.slug,
        yesSide: longIsHome ? "home" : "away",
      });
    })
  );
  return out;
}
