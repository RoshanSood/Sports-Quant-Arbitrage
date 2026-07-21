// Phase 4 matching engine (manual §5). Groups normalized markets into cross-venue
// matched events, enforcing the strict invariants that prevent fake arbs:
//   - same sport/league/teams/start-window (event key)
//   - TOTAL: same numeric line, opposite canonical outcomes (OVER/UNDER)
//   - reject low-confidence, line mismatches, same-outcome-only, self edges
//   - identity dedup of duplicate venue quotes
//
// Pure functions — no I/O. Consumes NormalizedMarket[] (Phase 3 ingestion output).

import { normalizeTeamName } from "@/lib/teamNormalization";
import type {
  MarketType,
  MatchedEvent,
  MatchedLeg,
  MatchMapData,
  MatchReject,
  MatchStats,
  NormalizedMarket,
  Outcome,
  Sport,
  VenueId,
} from "@/types/arbitrage";

const LINE_TOLERANCE = 0.001;
const CONFIDENCE_FLOOR = 0.88;
const START_WINDOW_MINUTES = 20;

export function normalizeSport(sport: string): string {
  return sport.toLowerCase().trim();
}

export function normalizeLeague(league: string): string {
  return league.toLowerCase().trim();
}

// Bucket the start time so venues that report slightly different kickoff strings
// still collide. Falls back to the raw value (e.g. a YYYY-MM-DD date) when the
// timestamp can't be parsed.
export function startBucket(startTime: string, windowMinutes = START_WINDOW_MINUTES): string {
  const ms = Date.parse(startTime);
  if (Number.isNaN(ms)) return startTime;
  const windowMs = windowMinutes * 60_000;
  return new Date(Math.round(ms / windowMs) * windowMs).toISOString();
}

// eventKey = sport + league + sorted canonical teams + start bucket (manual §5).
// Teams are sorted for a stable identity; home/away order is preserved separately
// on the market for order placement.
export function buildEventKey(market: NormalizedMarket): string {
  const sport = normalizeSport(market.sport);
  const league = normalizeLeague(market.league);
  const teams = market.teams.map(normalizeTeamName).sort();
  const bucket = startBucket(market.startTime);
  return `${sport}:${league}:${teams[0]}|${teams[1]}:${bucket}`;
}

function startDeltaMinutes(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.abs(ta - tb) / 60_000;
}

// Confidence per manual §5 weights. Inputs are already ESPN-canonicalized so team
// and league scores are high, but we still compute deterministically so the gate is
// meaningful when feeds diverge.
function confidenceScore(a: NormalizedMarket, b: NormalizedMarket): number {
  const teamScore =
    normalizeTeamName(a.teams[0]) === normalizeTeamName(b.teams[0]) &&
    normalizeTeamName(a.teams[1]) === normalizeTeamName(b.teams[1])
      ? 1
      : 0;
  const delta = startDeltaMinutes(a.startTime, b.startTime);
  const timeScore = delta <= START_WINDOW_MINUTES ? 1 : delta <= 360 ? 0.5 : 0;
  const leagueScore = normalizeLeague(a.league) === normalizeLeague(b.league) ? 1 : 0;
  const marketTypeScore = a.marketType === b.marketType ? 1 : 0;
  const lineScore = Math.abs((a.line ?? 0) - (b.line ?? 0)) <= LINE_TOLERANCE ? 1 : 0;
  return (
    teamScore * 0.45 +
    timeScore * 0.25 +
    leagueScore * 0.1 +
    marketTypeScore * 0.1 +
    lineScore * 0.1
  );
}

function venuePairKey(venues: VenueId[]): string {
  return [...new Set(venues)].sort().join("+");
}

// Human-readable side label: "over 6.5" (totals), team name (moneyline; "Draw" for the
// soccer 1X2 middle outcome), "Cardinals +1.5" (spread — the team with its signed run-line).
function legLabel(m: NormalizedMarket): string {
  if (m.marketType === "moneyline") {
    if (m.outcome === "draw") return "Draw";
    return m.outcome === "home" ? m.teams[1] : m.teams[0];
  }
  if (m.marketType === "spread") {
    const team = m.outcome === "home" ? m.teams[1] : m.teams[0];
    const homeLine = m.line ?? 0;
    const signed = m.outcome === "home" ? homeLine : -homeLine;
    return `${team} ${signed > 0 ? "+" : ""}${signed}`;
  }
  return `${m.outcome} ${m.line ?? ""}`.trim();
}

function toLeg(m: NormalizedMarket): MatchedLeg {
  return {
    venueId: m.venueId,
    marketId: m.marketId,
    nativeMarketId: m.nativeMarketId,
    nativeSide: m.nativeSide,
    outcome: m.outcome,
    line: m.line ?? 0,
    priceCents: m.priceCents,
    decimalOdds: m.decimalOdds,
    impliedProbability: m.impliedProbability,
    liquidityUsd: m.liquidityUsd,
    label: legLabel(m),
  };
}

// Generic matcher for LINED two-way markets (totals over/under, spread home/away).
// Requires the same numeric line on both venues before comparing complementary sides.
function matchLined(
  markets: NormalizedMarket[],
  marketType: MarketType,
  aOutcome: Outcome,
  bOutcome: Outcome
): MatchMapData {
  const stats: MatchStats = {
    matched: 0,
    byVenue: {},
    byVenuePair: {},
    dedupDropped: 0,
    selfEdgeDropped: 0,
    lineMismatch: 0,
    invariantRejected: 0,
  };
  const matched: MatchedEvent[] = [];
  const rejects: MatchReject[] = [];

  const pool = markets.filter((m) => m.marketType === marketType && m.status === "open");

  // 1. Group by event key.
  const groups = new Map<string, NormalizedMarket[]>();
  for (const m of pool) {
    const key = buildEventKey(m);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }

  for (const [eventKey, groupRaw] of groups) {
    const first = groupRaw[0];
    const matchup = `${first.teams[0]} v ${first.teams[1]}`;

    // 2. Identity dedup: collapse duplicate (venue, line, outcome) quotes, keep freshest.
    const seen = new Map<string, NormalizedMarket>();
    for (const m of groupRaw) {
      const k = `${m.venueId}:${m.line}:${m.outcome}`;
      const prev = seen.get(k);
      if (!prev) seen.set(k, m);
      else {
        stats.dedupDropped += 1;
        if (Date.parse(m.lastUpdated) > Date.parse(prev.lastUpdated)) seen.set(k, m);
      }
    }
    const group = [...seen.values()];

    const venuesInGroup = new Set(group.map((m) => m.venueId));
    if (venuesInGroup.size < 2) continue; // only one venue has this event — nothing to match

    // 3. Bucket by line; a matchable line must appear on >= 2 venues.
    const byLine = new Map<number, NormalizedMarket[]>();
    for (const m of group) {
      const line = m.line ?? 0;
      (byLine.get(line) ?? byLine.set(line, []).get(line)!).push(m);
    }

    const commonLines = [...byLine.entries()].filter(
      ([, ms]) => new Set(ms.map((m) => m.venueId)).size >= 2
    );

    if (commonLines.length === 0) {
      // Venues quote this market but on different lines — the classic false-arb trap.
      const lines = [...byLine.keys()].sort((a, b) => a - b).join(", ");
      rejects.push({
        eventKey,
        matchup,
        marketType,
        reason: "line_mismatch",
        detail: `venues quote different lines (${lines}); require equal line`,
      });
      stats.lineMismatch += 1;
      stats.invariantRejected += 1;
      continue;
    }

    for (const [line, lineMs] of commonLines) {
      const aLegs = lineMs.filter((m) => m.outcome === aOutcome);
      const bLegs = lineMs.filter((m) => m.outcome === bOutcome);

      if (aLegs.length === 0 || bLegs.length === 0) {
        rejects.push({
          eventKey,
          matchup,
          marketType,
          reason: "same_outcome",
          detail: `line ${line} only has one side across venues`,
        });
        stats.invariantRejected += 1;
        continue;
      }

      // Cross-venue complementary pair required (no intra-venue self edge).
      const hasCrossVenue = aLegs.some((a) => bLegs.some((b) => a.venueId !== b.venueId));
      if (!hasCrossVenue) {
        rejects.push({
          eventKey,
          matchup,
          marketType,
          reason: "self_edge",
          detail: `line ${line} both sides only on a single venue`,
        });
        stats.selfEdgeDropped += 1;
        continue;
      }

      const confidence = confidenceScore(aLegs[0], bLegs[0]);
      if (confidence < CONFIDENCE_FLOOR) {
        rejects.push({
          eventKey,
          matchup,
          marketType,
          reason: "match_confidence_low",
          detail: `confidence ${(confidence * 100).toFixed(0)}% < ${CONFIDENCE_FLOOR * 100}%`,
        });
        stats.invariantRejected += 1;
        continue;
      }

      const legs = lineMs.map(toLeg);
      const venues = [...new Set(lineMs.map((m) => m.venueId))];
      matched.push({
        eventKey,
        matchup,
        sport: first.sport as Sport,
        league: first.league,
        startWindow: startBucket(first.startTime),
        canonicalTeams: first.teams,
        marketType,
        line,
        venues,
        legs,
        confidence,
      });

      stats.matched += 1;
      for (const v of venues) stats.byVenue[v] = (stats.byVenue[v] ?? 0) + 1;
      stats.byVenuePair[venuePairKey(venues)] = (stats.byVenuePair[venuePairKey(venues)] ?? 0) + 1;
    }
  }

  return { matched, rejects, stats };
}

// Match game totals (over/under, same line) across venues.
export function matchTotals(markets: NormalizedMarket[]): MatchMapData {
  return matchLined(markets, "total", "over", "under");
}

// Match run-line spreads (home/away cover, same signed home line) across venues.
export function matchSpread(markets: NormalizedMarket[]): MatchMapData {
  return matchLined(markets, "spread", "home", "away");
}

// Match moneyline (2-way home/away) across venues — one matched market per game.
export function matchMoneyline(markets: NormalizedMarket[]): MatchMapData {
  const stats: MatchStats = {
    matched: 0,
    byVenue: {},
    byVenuePair: {},
    dedupDropped: 0,
    selfEdgeDropped: 0,
    lineMismatch: 0,
    invariantRejected: 0,
  };
  const matched: MatchedEvent[] = [];
  const rejects: MatchReject[] = [];

  const ml = markets.filter((m) => m.marketType === "moneyline" && m.status === "open");
  const groups = new Map<string, NormalizedMarket[]>();
  for (const m of ml) {
    const key = buildEventKey(m);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }

  for (const [eventKey, groupRaw] of groups) {
    const first = groupRaw[0];
    const matchup = `${first.teams[0]} v ${first.teams[1]}`;

    // Dedup duplicate (venue, outcome) quotes.
    const seen = new Map<string, NormalizedMarket>();
    for (const m of groupRaw) {
      const k = `${m.venueId}:${m.outcome}`;
      if (!seen.has(k)) seen.set(k, m);
      else stats.dedupDropped += 1;
    }
    const group = [...seen.values()];
    const venuesSet = new Set(group.map((m) => m.venueId));
    if (venuesSet.size < 2) continue;

    const homes = group.filter((m) => m.outcome === "home");
    const aways = group.filter((m) => m.outcome === "away");
    if (homes.length === 0 || aways.length === 0) {
      rejects.push({ eventKey, matchup, marketType: "moneyline", reason: "same_outcome", detail: "only one side available across venues" });
      stats.invariantRejected += 1;
      continue;
    }
    if (!homes.some((h) => aways.some((a) => h.venueId !== a.venueId))) {
      rejects.push({ eventKey, matchup, marketType: "moneyline", reason: "self_edge", detail: "home/away only on a single venue" });
      stats.selfEdgeDropped += 1;
      continue;
    }

    const venues = [...venuesSet];
    matched.push({
      eventKey,
      matchup,
      sport: first.sport as Sport,
      league: first.league,
      startWindow: startBucket(first.startTime),
      canonicalTeams: first.teams,
      marketType: "moneyline",
      line: 0,
      venues,
      legs: group.map(toLeg),
      confidence: 1,
    });
    stats.matched += 1;
    for (const v of venues) stats.byVenue[v] = (stats.byVenue[v] ?? 0) + 1;
    stats.byVenuePair[venuePairKey(venues)] = (stats.byVenuePair[venuePairKey(venues)] ?? 0) + 1;
  }

  return { matched, rejects, stats };
}

// Match all supported market types and merge the maps for the Match Map panel.
export function matchMarkets(markets: NormalizedMarket[]): MatchMapData {
  const parts = [matchTotals(markets), matchMoneyline(markets), matchSpread(markets)];
  const byVenue: Record<string, number> = {};
  const byVenuePair: Record<string, number> = {};
  const stats: MatchStats = {
    matched: 0, byVenue, byVenuePair,
    dedupDropped: 0, selfEdgeDropped: 0, lineMismatch: 0, invariantRejected: 0,
  };
  const matched: MatchedEvent[] = [];
  const rejects: MatchReject[] = [];
  for (const p of parts) {
    matched.push(...p.matched);
    rejects.push(...p.rejects);
    stats.matched += p.stats.matched;
    stats.dedupDropped += p.stats.dedupDropped;
    stats.selfEdgeDropped += p.stats.selfEdgeDropped;
    stats.lineMismatch += p.stats.lineMismatch;
    stats.invariantRejected += p.stats.invariantRejected;
    for (const [k, v] of Object.entries(p.stats.byVenue)) byVenue[k] = (byVenue[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.stats.byVenuePair)) byVenuePair[k] = (byVenuePair[k] ?? 0) + v;
  }
  return { matched, rejects, stats };
}
