// Cloudbet venue adapter (read side). Cloudbet is a crypto SPORTSBOOK (not an exchange)
// with a REST Feed API. We read a competition's moneyline from the feed
// (GET /pub/v2/odds/competitions/{competition}?markets={marketKey}), which returns each
// event with home/away teams and a moneyline submarket priced as DECIMAL odds. Cost in
// cents for a $1 payout = 100 / decimalPrice (so the outcomes sum to >100¢ by the book's
// overround). Auth is an X-API-Key JWT (CLOUDBET_API_KEY). Normalized into the shared
// VenueTwoWay shape so matching + arb detection treat Cloudbet like any other venue.
//
// Handles 2-way (baseball/tennis: home/away) AND 3-way (soccer 1X2: home/draw/away, via
// the config's `threeWay` flag) — the draw leg rides on VenueTwoWay's optional draw fields.
// Each outcome's Cloudbet "market URL" (`marketKey/outcome`) is threaded as the native
// side for order placement. Book bets are all-or-nothing and irreversible.

import type { VenueTwoWay } from "./kalshi";
import type { ArbGame, CloudbetSportCfg } from "./arbitrage/sports";
import { teamsMatch } from "./teamNormalization";

const API = "https://sports-api.cloudbet.com/pub/v2/odds";

type CbSelection = { outcome?: string; params?: string; price?: number; minStake?: number; status?: string; side?: string };
type CbSubmarket = { selections?: CbSelection[] };
type CbMarket = { submarkets?: Record<string, CbSubmarket>; liability?: number };
type CbTeam = { name?: string; key?: string; abbreviation?: string } | null;
type CbEvent = { id: number; home: CbTeam; away: CbTeam; status?: string; markets?: Record<string, CbMarket> };

function apiKey(): string | undefined {
  return process.env.CLOUDBET_API_KEY?.trim() || undefined;
}

async function fetchCompetitionEvents(competition: string, marketKey: string): Promise<CbEvent[]> {
  const key = apiKey();
  if (!key) return []; // no key → no Cloudbet rows (read stays empty, never throws)
  try {
    const url = `${API}/competitions/${competition}?markets=${marketKey}`;
    const r = await fetch(url, { cache: "no-store", headers: { "X-API-Key": key, Accept: "application/json" } });
    if (!r.ok) return [];
    const j = (await r.json()) as { events?: CbEvent[] };
    return j.events ?? [];
  } catch (e) {
    console.error(`[cloudbet] ${competition} events fetch failed:`, e);
    return [];
  }
}

// First submarket carrying enabled selections; returns the enabled selection per outcome.
function moneylineSelections(ev: CbEvent, marketKey: string): { home?: CbSelection; away?: CbSelection; draw?: CbSelection } {
  const subs = ev.markets?.[marketKey]?.submarkets;
  if (!subs) return {};
  for (const sub of Object.values(subs)) {
    const sels = sub.selections ?? [];
    const enabled = (s: CbSelection) => !s.status || s.status === "SELECTION_ENABLED";
    const home = sels.find((s) => s.outcome === "home" && enabled(s));
    const away = sels.find((s) => s.outcome === "away" && enabled(s));
    const draw = sels.find((s) => s.outcome === "draw" && enabled(s));
    if (home && away) return { home, away, draw };
  }
  return {};
}

// Decimal odds → executable cost in cents for a $1 payout (100 / price).
const cents = (price?: number): number | null =>
  typeof price === "number" && price > 1 ? Number((100 / price).toFixed(4)) : null;

// Cloudbet moneyline per game for a configured competition/market. Cloudbet labels
// home/away explicitly; we match on the team SET and map Cloudbet's own home/away label
// onto the game's home/away, so the market URL threaded always references Cloudbet's
// outcome (not our orientation). For a 3-way (soccer) market the draw leg is included.
export async function fetchCloudbetMoneylineByGame(games: ArbGame[], cfg: CloudbetSportCfg): Promise<Map<string, VenueTwoWay>> {
  const out = new Map<string, VenueTwoWay>();
  if (!games.length) return out;
  const events = await fetchCompetitionEvents(cfg.competition, cfg.moneyline);
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

    const { home, away, draw } = moneylineSelections(ev, cfg.moneyline);
    // Which Cloudbet side is the game's HOME team?
    const cbHomeIsGameHome = teamsMatch(ev.home?.name ?? "", game.homeTeam.name);
    const homeSel = cbHomeIsGameHome ? home : away;
    const awaySel = cbHomeIsGameHome ? away : home;
    const homeCents = cents(homeSel?.price);
    const awayCents = cents(awaySel?.price);
    if (homeCents == null || awayCents == null) continue;
    // A 3-way market that is missing the draw price is dropped (can't form a valid 1X2).
    const drawCents = cfg.threeWay ? cents(draw?.price) : null;
    if (cfg.threeWay && drawCents == null) continue;

    // Book capacity proxy: the market's liability is the most Cloudbet will lose on it.
    const liq = typeof ev.markets?.[cfg.moneyline]?.liability === "number" ? Math.round(ev.markets[cfg.moneyline].liability!) : 0;

    out.set(game.id, {
      homeCents,
      awayCents,
      homeLiquidityUsd: liq,
      awayLiquidityUsd: liq,
      marketId: String(ev.id),
      // Cloudbet market URL per outcome (`marketKey/outcome`) — reference Cloudbet's own
      // home/away label, not our game orientation.
      homeTokenId: `${cfg.moneyline}/${cbHomeIsGameHome ? "home" : "away"}`,
      awayTokenId: `${cfg.moneyline}/${cbHomeIsGameHome ? "away" : "home"}`,
      ...(drawCents != null
        ? { drawCents, drawLiquidityUsd: liq, drawTokenId: `${cfg.moneyline}/draw` }
        : {}),
    });
  }
  return out;
}
