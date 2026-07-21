// Cloudbet venue adapter (read side). Cloudbet is a crypto SPORTSBOOK (not an exchange)
// with a REST Feed API. We read MLB moneyline from the competition feed
// (GET /pub/v2/odds/competitions/baseball-usa-mlb?markets=baseball.moneyline), which
// returns each event with home/away teams and a 2-way moneyline submarket priced as
// DECIMAL odds. Cost in cents for a $1 payout = 100 / decimalPrice (so the two sides sum
// to >100¢ by the book's overround). Auth is an X-API-Key JWT (CLOUDBET_API_KEY).
// Normalized into the shared VenueTwoWay shape so matching + arb detection treat Cloudbet
// like any other venue. Book bets are all-or-nothing and irreversible (no order book).
//
// MLB moneyline only for now (like predict.fun). Each outcome's Cloudbet "market URL"
// (`baseball.moneyline/home|away`) is threaded as the native side for order placement.

import type { VenueTwoWay } from "./kalshi";
import type { ArbGame } from "./arbitrage/sports";
import { teamsMatch } from "./teamNormalization";

const API = "https://sports-api.cloudbet.com/pub/v2/odds";
const MLB_COMPETITION = "baseball-usa-mlb";
const MONEYLINE = "baseball.moneyline";

type CbSelection = { outcome?: string; params?: string; price?: number; minStake?: number; status?: string; side?: string };
type CbSubmarket = { selections?: CbSelection[] };
type CbMarket = { submarkets?: Record<string, CbSubmarket>; liability?: number };
type CbTeam = { name?: string; key?: string; abbreviation?: string } | null;
type CbEvent = { id: number; home: CbTeam; away: CbTeam; status?: string; markets?: Record<string, CbMarket> };

function apiKey(): string | undefined {
  return process.env.CLOUDBET_API_KEY?.trim() || undefined;
}

async function fetchMlbEvents(): Promise<CbEvent[]> {
  const key = apiKey();
  if (!key) return []; // no key → no Cloudbet rows (read stays empty, never throws)
  try {
    const url = `${API}/competitions/${MLB_COMPETITION}?markets=${MONEYLINE}`;
    const r = await fetch(url, { cache: "no-store", headers: { "X-API-Key": key, Accept: "application/json" } });
    if (!r.ok) return [];
    const j = (await r.json()) as { events?: CbEvent[] };
    return j.events ?? [];
  } catch (e) {
    console.error("[cloudbet] events fetch failed:", e);
    return [];
  }
}

// First submarket that carries an enabled home + away selection (moneyline is a single
// full-time submarket, but we scan defensively).
function moneylineSelections(ev: CbEvent): { home?: CbSelection; away?: CbSelection } {
  const subs = ev.markets?.[MONEYLINE]?.submarkets;
  if (!subs) return {};
  for (const sub of Object.values(subs)) {
    const sels = sub.selections ?? [];
    const enabled = (s: CbSelection) => !s.status || s.status === "SELECTION_ENABLED";
    const home = sels.find((s) => s.outcome === "home" && enabled(s));
    const away = sels.find((s) => s.outcome === "away" && enabled(s));
    if (home && away) return { home, away };
  }
  return {};
}

// Decimal odds → executable cost in cents for a $1 payout (100 / price).
const cents = (price?: number): number | null =>
  typeof price === "number" && price > 1 ? Number((100 / price).toFixed(4)) : null;

// Cloudbet MLB moneyline per game. Cloudbet labels home/away explicitly; we match on the
// team SET and then map Cloudbet's own home/away label onto the game's home/away, so the
// market URL we thread always references Cloudbet's outcome (not our orientation).
export async function fetchCloudbetMoneylineByGame(games: ArbGame[]): Promise<Map<string, VenueTwoWay>> {
  const out = new Map<string, VenueTwoWay>();
  if (!games.length) return out;
  const events = await fetchMlbEvents();
  if (!events.length) return out;

  for (const game of games) {
    const ev = events.find((e) => {
      if (e.status && e.status !== "TRADING" && e.status !== "TRADING_LIVE") return false;
      const h = e.home?.name, a = e.away?.name;
      if (!h || !a) return false;
      return (
        (teamsMatch(h, game.homeTeam.name) && teamsMatch(a, game.awayTeam.name)) ||
        (teamsMatch(h, game.awayTeam.name) && teamsMatch(a, game.homeTeam.name))
      );
    });
    if (!ev) continue;

    const { home, away } = moneylineSelections(ev);
    // Which Cloudbet side is the game's HOME team?
    const cbHomeIsGameHome = teamsMatch(ev.home?.name ?? "", game.homeTeam.name);
    const homeSel = cbHomeIsGameHome ? home : away;
    const awaySel = cbHomeIsGameHome ? away : home;
    const homeCents = cents(homeSel?.price);
    const awayCents = cents(awaySel?.price);
    if (homeCents == null || awayCents == null) continue;

    // Book capacity proxy: the market's liability is the most Cloudbet will lose on it.
    const liq = typeof ev.markets?.[MONEYLINE]?.liability === "number" ? Math.round(ev.markets[MONEYLINE].liability!) : 0;

    out.set(game.id, {
      homeCents,
      awayCents,
      homeLiquidityUsd: liq,
      awayLiquidityUsd: liq,
      marketId: String(ev.id),
      // Cloudbet market URL per outcome (`marketKey/outcome`) — the native side an order
      // needs. Reference Cloudbet's own home/away label, not our game orientation.
      homeTokenId: `${MONEYLINE}/${cbHomeIsGameHome ? "home" : "away"}`,
      awayTokenId: `${MONEYLINE}/${cbHomeIsGameHome ? "away" : "home"}`,
    });
  }
  return out;
}
