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

type CbSelection = { outcome?: string; params?: string; marketUrl?: string; price?: number; minStake?: number; maxStake?: number; status?: string; side?: string };
type CbSubmarket = { selections?: CbSelection[] };
type CbMarket = { submarkets?: Record<string, CbSubmarket>; liability?: number };
type CbTeam = { name?: string; key?: string; abbreviation?: string } | null;
type CbEvent = { id: number; home: CbTeam; away: CbTeam; status?: string; cutoffTime?: string; markets?: Record<string, CbMarket> };

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
        // Cloudbet does not consistently namespace tour events under tennis-atp-* or
        // tennis-wta-*. The Rogers events, for example, use tennis-canada-* keys while
        // their competition names carry ATP/WTA. Match both catalog fields so those
        // tournaments are discoverable without brittle event-specific identifiers.
        if (c.key && (c.eventCount ?? 0) > 0 && match.test(`${c.key} ${c.name ?? ""}`)) out.push(c.key);
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

function eventSlateDate(ev: CbEvent): string | null {
  if (!ev.cutoffTime) return null;
  const d = new Date(ev.cutoffTime);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function eventMatchesGame(ev: CbEvent, game: ArbGame): boolean {
  if (ev.status && ev.status !== "TRADING" && ev.status !== "TRADING_LIVE") return false;
  const nativeDate = eventSlateDate(ev);
  if (nativeDate && nativeDate !== game.date) return false;
  const h = ev.home?.name, a = ev.away?.name;
  if (!h || !a) return false;
  return (
    (teamsMatch(h, game.homeTeam.name) && teamsMatch(a, game.awayTeam.name)) ||
    (teamsMatch(h, game.awayTeam.name) && teamsMatch(a, game.homeTeam.name))
  );
}

function enabledSelection(selection: CbSelection | undefined): selection is CbSelection {
  return Boolean(selection && (!selection.status || selection.status === "SELECTION_ENABLED") && cents(selection.price) != null);
}

function marketLiquidity(ev: CbEvent, marketKey: string, selections: CbSelection[]): number {
  const liability = ev.markets?.[marketKey]?.liability;
  if (typeof liability === "number" && liability > 0) return Math.round(liability);
  const limits = selections.map((selection) => Number(selection.maxStake)).filter((value) => Number.isFinite(value) && value > 0);
  return limits.length ? Math.round(Math.min(...limits)) : 0;
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
    const ev = events.find((event) => eventMatchesGame(event, game));
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
    const liq = marketLiquidity(ev, cfg.moneyline, [homeSel, awaySel, draw].filter((selection): selection is CbSelection => Boolean(selection)));

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
      sourceStartTime: eventSlateDate(ev) ?? game.date,
    });
  }
  return out;
}

const paramNumber = (params: string | undefined, key: string): number | null => {
  const match = params?.match(new RegExp(`(?:^|&)${key}=(-?\\d+(?:\\.\\d+)?)`));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : null;
};

const isHalfGoalLine = (line: number): boolean => Math.abs(Math.abs(line) % 1 - 0.5) < 1e-9;

export async function fetchCloudbetTotalsByGame(
  games: ArbGame[],
  cfg: CloudbetSportCfg
): Promise<Map<string, VenueTotalLine[]>> {
  const out = new Map<string, VenueTotalLine[]>();
  if (!games.length || !cfg.total) return out;
  const competitions = cfg.competition
    ? [cfg.competition]
    : cfg.sport && cfg.competitionMatch
      ? await fetchCompetitionKeys(cfg.sport, cfg.competitionMatch)
      : [];
  const events: CbEvent[] = [];
  for (const competition of competitions.slice(0, 24)) events.push(...await fetchCompetitionEvents(competition, cfg.total));

  for (const game of games) {
    const ev = events.find((event) => eventMatchesGame(event, game));
    if (!ev) continue;
    const selections = Object.values(ev.markets?.[cfg.total]?.submarkets ?? {}).flatMap((submarket) => submarket.selections ?? []);
    const lines: VenueTotalLine[] = [];
    const totals = [...new Set(selections.map((selection) => paramNumber(selection.params, "total")).filter((line): line is number => line != null && isHalfGoalLine(line)))];
    for (const line of totals) {
      const over = selections.find((selection) => selection.outcome === "over" && paramNumber(selection.params, "total") === line && enabledSelection(selection));
      const under = selections.find((selection) => selection.outcome === "under" && paramNumber(selection.params, "total") === line && enabledSelection(selection));
      if (!over || !under) continue;
      const overCents = cents(over.price), underCents = cents(under.price);
      if (overCents == null || underCents == null) continue;
      const liquidity = marketLiquidity(ev, cfg.total, [over, under]);
      lines.push({
        line,
        overCents,
        underCents,
        overLiquidityUsd: liquidity,
        underLiquidityUsd: liquidity,
        marketId: String(ev.id),
        overTokenId: over.marketUrl ?? `${cfg.total}/over?total=${line}`,
        underTokenId: under.marketUrl ?? `${cfg.total}/under?total=${line}`,
        sourceStartTime: eventSlateDate(ev) ?? game.date,
      });
    }
    if (lines.length) out.set(game.id, lines);
  }
  return out;
}

export async function fetchCloudbetSpreadByGame(
  games: ArbGame[],
  cfg: CloudbetSportCfg
): Promise<Map<string, VenueSpread>> {
  const out = new Map<string, VenueSpread>();
  if (!games.length || !cfg.spread) return out;
  const competitions = cfg.competition
    ? [cfg.competition]
    : cfg.sport && cfg.competitionMatch
      ? await fetchCompetitionKeys(cfg.sport, cfg.competitionMatch)
      : [];
  const events: CbEvent[] = [];
  for (const competition of competitions.slice(0, 24)) events.push(...await fetchCompetitionEvents(competition, cfg.spread));

  for (const game of games) {
    const ev = events.find((event) => eventMatchesGame(event, game));
    if (!ev) continue;
    const selections = Object.values(ev.markets?.[cfg.spread]?.submarkets ?? {}).flatMap((submarket) => submarket.selections ?? []);
    const candidates: VenueSpread[] = [];
    const handicaps = [...new Set(selections.map((selection) => paramNumber(selection.params, "handicap")).filter((line): line is number => line != null && isHalfGoalLine(line)))];
    const cbHomeIsGameHome = teamsMatch(ev.home?.name ?? "", game.homeTeam.name);
    for (const handicap of handicaps) {
      const cbHome = selections.find((selection) => selection.outcome === "home" && paramNumber(selection.params, "handicap") === handicap && enabledSelection(selection));
      const cbAway = selections.find((selection) => selection.outcome === "away" && paramNumber(selection.params, "handicap") === handicap && enabledSelection(selection));
      if (!cbHome || !cbAway) continue;
      const homeSelection = cbHomeIsGameHome ? cbHome : cbAway;
      const awaySelection = cbHomeIsGameHome ? cbAway : cbHome;
      const homeCents = cents(homeSelection.price), awayCents = cents(awaySelection.price);
      if (homeCents == null || awayCents == null) continue;
      const liquidity = marketLiquidity(ev, cfg.spread, [homeSelection, awaySelection]);
      candidates.push({
        homeCents,
        awayCents,
        homeLiquidityUsd: liquidity,
        awayLiquidityUsd: liquidity,
        homeSignedLine: cbHomeIsGameHome ? handicap : -handicap,
        marketId: String(ev.id),
        homeTokenId: homeSelection.marketUrl,
        awayTokenId: awaySelection.marketUrl,
        sourceStartTime: eventSlateDate(ev) ?? game.date,
      });
    }
    // Prefer the tightest executable pair; Kalshi matching will still require the exact line.
    const eligible = cfg.spreadLine == null
      ? candidates
      : candidates.filter((candidate) => Math.abs(Math.abs(candidate.homeSignedLine) - cfg.spreadLine!) < 0.01);
    eligible.sort((a, b) => (a.homeCents + a.awayCents) - (b.homeCents + b.awayCents));
    if (eligible[0]) out.set(game.id, eligible[0]);
  }
  return out;
}
