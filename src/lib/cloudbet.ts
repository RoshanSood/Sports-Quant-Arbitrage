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

import type { VenueSpread, VenueTotalLine, VenueTwoWay } from "./kalshi";
import type { ArbGame, CloudbetSportCfg } from "./arbitrage/sports";
import { teamsMatch } from "./teamNormalization";

const API = "https://sports-api.cloudbet.com/pub/v2/odds";

type CbSelection = { outcome?: string; params?: string; price?: number; minStake?: number; status?: string; side?: string };
type CbSubmarket = { selections?: CbSelection[] };
type CbMarket = { submarkets?: Record<string, CbSubmarket>; liability?: number };
type CbTeam = { name?: string; key?: string; abbreviation?: string } | null;
type CbEvent = { id: number; home: CbTeam; away: CbTeam; status?: string; cutoffTime?: string; markets?: Record<string, CbMarket> };

const DEFAULT_BOOK_LIQUIDITY_USD = 1000;

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

// Single-event odds — fresher than the competition roll-up and the only way to catch a
// LIVE market's brief enabled window (the competition feed usually snapshots it suspended).
async function fetchEvent(eventId: number | string, marketKey: string): Promise<CbEvent | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const r = await fetch(`${API}/events/${encodeURIComponent(String(eventId))}?markets=${marketKey}`, {
      cache: "no-store",
      headers: { "X-API-Key": key, Accept: "application/json" },
    });
    if (!r.ok) return null;
    return (await r.json()) as CbEvent;
  } catch {
    return null;
  }
}

// A LIVE event's moneyline suspends between plays; re-poll the single-event feed a few
// times to catch an enabled window before giving up on the quote. No-op for markets that
// are already enabled (returns the selections on the first pass).
async function liveMoneylineSelections(
  ev: CbEvent,
  marketKey: string,
  tries = 5
): Promise<{ home?: CbSelection; away?: CbSelection; draw?: CbSelection }> {
  let sel = moneylineSelections(ev, marketKey);
  if (sel.home && sel.away) return sel;
  for (let i = 0; i < tries && ev.status === "TRADING_LIVE"; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const fresh = await fetchEvent(ev.id, marketKey);
    if (!fresh) continue;
    sel = moneylineSelections(fresh, marketKey);
    if (sel.home && sel.away) return sel;
  }
  return sel;
}

// Enumerate a sport's competition keys (with events) whose key matches — for sports whose
// competitions are per-tournament (WTA: tennis-wta-*).
type CbCompetition = { key?: string; name?: string; eventCount?: number };
async function fetchCompetitionKeys(sport: string, match: RegExp): Promise<string[]> {
  const key = apiKey();
  if (!key) return [];
  try {
    const r = await fetch(`${API}/sports/${sport}`, { cache: "no-store", headers: { "X-API-Key": key, Accept: "application/json" } });
    if (!r.ok) return [];
    const j = (await r.json()) as { categories?: { competitions?: CbCompetition[] }[] };
    const out: string[] = [];
    for (const cat of j.categories ?? []) {
      for (const c of cat.competitions ?? []) {
        if (c.key && (c.eventCount ?? 0) > 0 && match.test(c.key)) out.push(c.key);
      }
    }
    return out;
  } catch (e) {
    console.error(`[cloudbet] /sports/${sport} fetch failed:`, e);
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

function bookLiquidity(ev: CbEvent, marketKey: string): number {
  const liq = ev.markets?.[marketKey]?.liability;
  return typeof liq === "number" && Number.isFinite(liq) && liq > 0 ? Math.round(liq) : DEFAULT_BOOK_LIQUIDITY_USD;
}

function paramNumber(params: string | undefined, name: string): number | null {
  const value = new URLSearchParams(params ?? "").get(name);
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function marketUrl(marketKey: string, outcome: string, params?: string): string {
  return `${marketKey}/${outcome}${params ? `?${params}` : ""}`;
}

// Cloudbet moneyline per game for a configured competition/market. Cloudbet labels
// home/away explicitly; we match on the team SET and map Cloudbet's own home/away label
// onto the game's home/away, so the market URL threaded always references Cloudbet's
// outcome (not our orientation). For a 3-way (soccer) market the draw leg is included.
export async function fetchCloudbetMoneylineByGame(games: ArbGame[], cfg: CloudbetSportCfg): Promise<Map<string, VenueTwoWay>> {
  const out = new Map<string, VenueTwoWay>();
  if (!games.length) return out;

  // Resolve the competition key(s): a fixed one (MLS/UCL) or a live enumeration (WTA).
  const competitions = cfg.competition
    ? [cfg.competition]
    : cfg.sport && cfg.competitionMatch
      ? await fetchCompetitionKeys(cfg.sport, cfg.competitionMatch)
      : [];
  if (!competitions.length) return out;

  const events: CbEvent[] = [];
  for (const comp of competitions.slice(0, 24)) {
    events.push(...(await fetchCompetitionEvents(comp, cfg.moneyline)));
  }
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

    const { home, away, draw } = await liveMoneylineSelections(ev, cfg.moneyline);
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
    const liq = bookLiquidity(ev, cfg.moneyline);

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
      sourceStartTime: ev.cutoffTime,
    });
  }
  return out;
}

export async function fetchCloudbetTotalsByGame(
  games: ArbGame[],
  cfg: CloudbetSportCfg
): Promise<Map<string, VenueTotalLine[]>> {
  const out = new Map<string, VenueTotalLine[]>();
  if (!games.length || !cfg.totals) return out;

  const events = await fetchCloudbetEventsForCfg(cfg, cfg.totals);
  if (!events.length) return out;

  for (const game of games) {
    const ev = findEventForGame(events, game);
    if (!ev) continue;
    const rows = totalRowsFromEvent(ev, cfg.totals);
    if (rows.length) out.set(game.id, rows);
  }
  return out;
}

export async function fetchCloudbetSpreadByGame(
  games: ArbGame[],
  cfg: CloudbetSportCfg
): Promise<Map<string, VenueSpread>> {
  const out = new Map<string, VenueSpread>();
  if (!games.length || !cfg.spread) return out;

  const events = await fetchCloudbetEventsForCfg(cfg, cfg.spread);
  if (!events.length) return out;

  for (const game of games) {
    const ev = findEventForGame(events, game);
    if (!ev) continue;
    const spread = spreadFromEvent(ev, game, cfg.spread);
    if (spread) out.set(game.id, spread);
  }
  return out;
}

export async function fetchCloudbetFeedDiagnostics(
  games: ArbGame[],
  cfg: CloudbetSportCfg
): Promise<{ fetched: number; matchedDate: number; priced: number }> {
  const keys = [cfg.moneyline, cfg.totals, cfg.spread].filter((k): k is string => Boolean(k));
  const all = new Map<number, CbEvent>();
  for (const key of keys) {
    for (const ev of await fetchCloudbetEventsForCfg(cfg, key)) {
      const prev = all.get(ev.id);
      all.set(ev.id, prev ? { ...prev, ...ev, markets: { ...prev.markets, ...ev.markets } } : ev);
    }
  }
  let matchedDate = 0;
  let priced = 0;
  for (const game of games) {
    const ev = findEventForGame([...all.values()], game);
    if (!ev) continue;
    matchedDate += 1;
    if (moneylineSelections(ev, cfg.moneyline).home && moneylineSelections(ev, cfg.moneyline).away) priced += 1;
  }
  return { fetched: all.size, matchedDate, priced };
}

async function fetchCloudbetEventsForCfg(cfg: CloudbetSportCfg, marketKey: string): Promise<CbEvent[]> {
  const competitions = cfg.competition
    ? [cfg.competition]
    : cfg.sport && cfg.competitionMatch
      ? await fetchCompetitionKeys(cfg.sport, cfg.competitionMatch)
      : [];
  const events: CbEvent[] = [];
  for (const comp of competitions.slice(0, 24)) {
    events.push(...(await fetchCompetitionEvents(comp, marketKey)));
  }
  return events;
}

function findEventForGame(events: CbEvent[], game: ArbGame): CbEvent | null {
  return (
    events.find((e) => {
      if (e.status && e.status !== "TRADING" && e.status !== "TRADING_LIVE") return false;
      const h = e.home?.name, a = e.away?.name;
      if (!h || !a) return false;
      return (
        (teamsMatch(h, game.homeTeam.name) && teamsMatch(a, game.awayTeam.name)) ||
        (teamsMatch(h, game.awayTeam.name) && teamsMatch(a, game.homeTeam.name))
      );
    }) ?? null
  );
}

function enabledSelections(ev: CbEvent, marketKey: string): CbSelection[] {
  const subs = ev.markets?.[marketKey]?.submarkets ?? {};
  const out: CbSelection[] = [];
  for (const sub of Object.values(subs)) {
    for (const sel of sub.selections ?? []) {
      if ((!sel.status || sel.status === "SELECTION_ENABLED") && typeof sel.price === "number" && sel.price > 1) out.push(sel);
    }
  }
  return out;
}

function totalRowsFromEvent(ev: CbEvent, marketKey: string): VenueTotalLine[] {
  const byLine = new Map<number, { over?: CbSelection; under?: CbSelection }>();
  for (const sel of enabledSelections(ev, marketKey)) {
    if (sel.outcome !== "over" && sel.outcome !== "under") continue;
    const line = paramNumber(sel.params, "total");
    if (line == null) continue;
    const row = byLine.get(line) ?? {};
    row[sel.outcome] = sel;
    byLine.set(line, row);
  }
  const liq = bookLiquidity(ev, marketKey);
  return [...byLine.entries()].flatMap(([line, row]) => {
    const overCents = cents(row.over?.price);
    const underCents = cents(row.under?.price);
    if (overCents == null || underCents == null) return [];
    return [{
      line,
      overCents,
      underCents,
      overLiquidityUsd: liq,
      underLiquidityUsd: liq,
      marketId: String(ev.id),
      overTokenId: marketUrl(marketKey, "over", row.over?.params),
      underTokenId: marketUrl(marketKey, "under", row.under?.params),
      sourceStartTime: ev.cutoffTime,
    }];
  });
}

function spreadFromEvent(ev: CbEvent, game: ArbGame, marketKey: string): VenueSpread | null {
  const selections = enabledSelections(ev, marketKey);
  const byHandicap = new Map<number, { home?: CbSelection; away?: CbSelection }>();
  for (const sel of selections) {
    if (sel.outcome !== "home" && sel.outcome !== "away") continue;
    const handicap = paramNumber(sel.params, "handicap");
    if (handicap == null) continue;
    const row = byHandicap.get(handicap) ?? {};
    row[sel.outcome] = sel;
    byHandicap.set(handicap, row);
  }
  const cbHomeIsGameHome = teamsMatch(ev.home?.name ?? "", game.homeTeam.name);
  let best: VenueSpread | null = null;
  let bestScore = Infinity;
  const liq = bookLiquidity(ev, marketKey);
  for (const [handicap, row] of byHandicap) {
    const homeSel = cbHomeIsGameHome ? row.home : row.away;
    const awaySel = cbHomeIsGameHome ? row.away : row.home;
    const homeCents = cents(homeSel?.price);
    const awayCents = cents(awaySel?.price);
    if (homeCents == null || awayCents == null) continue;
    const homeSignedLine = cbHomeIsGameHome ? handicap : -handicap;
    const score = Math.abs(homeSignedLine) + Math.abs(homeCents + awayCents - 105) / 100;
    if (score < bestScore) {
      bestScore = score;
      best = {
        homeCents,
        awayCents,
        homeLiquidityUsd: liq,
        awayLiquidityUsd: liq,
        homeSignedLine,
        marketId: String(ev.id),
        homeTokenId: marketUrl(marketKey, cbHomeIsGameHome ? "home" : "away", homeSel?.params),
        awayTokenId: marketUrl(marketKey, cbHomeIsGameHome ? "away" : "home", awaySel?.params),
        sourceStartTime: ev.cutoffTime,
      };
    }
  }
  return best;
}
