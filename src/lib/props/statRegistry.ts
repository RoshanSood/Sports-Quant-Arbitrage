// MLB canonical stat + period registry (manual §16). Each entry lists provider
// aliases, a display label, the natural line step, and a dispersion scale used by
// the line z-score. Matching resolves raw provider strings to a canonical id here;
// unknown labels are rejected rather than guessed (manual §15 — prefer a missing
// row over a false one). V1 scope is MLB only.

import type { CanonicalPeriod, CanonicalStat } from "@/types/props";

type StatRegistryEntry = CanonicalStat & {
  aliases: string[]; // lowercased provider labels that map here
  leagues: string[];
  allowedPeriodIds: string[];
};

// dispersionScale ≈ a typical cross-book line spread for the stat; used to turn raw
// line-gap units into a comparable z-score (manual §19). Tuned conservatively.
const MLB_STATS: StatRegistryEntry[] = [
  {
    id: "PITCHER_STRIKEOUTS",
    label: "Strikeouts (Pitcher)",
    shortLabel: "Pitcher Ks",
    naturalStep: 0.5,
    dispersionScale: 1.0,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["pitcher strikeouts", "pitcher ks", "strikeouts", "pitching ks", "strikeouts thrown", "player strikeouts", "ks"],
  },
  {
    id: "HITS_ALLOWED",
    label: "Hits Allowed (Pitcher)",
    shortLabel: "Hits Allowed",
    naturalStep: 0.5,
    dispersionScale: 1.0,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["hits allowed", "pitcher hits allowed", "pitching hits allowed"],
  },
  {
    id: "EARNED_RUNS",
    label: "Earned Runs Allowed",
    shortLabel: "Earned Runs",
    naturalStep: 0.5,
    dispersionScale: 0.75,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["earned runs", "earned runs allowed", "pitcher earned runs"],
  },
  {
    id: "OUTS_RECORDED",
    label: "Outs Recorded (Pitcher)",
    shortLabel: "Outs Recorded",
    naturalStep: 0.5,
    dispersionScale: 1.5,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["outs recorded", "outs", "pitcher outs"],
  },
  {
    id: "WALKS_ALLOWED",
    label: "Walks Allowed (Pitcher)",
    shortLabel: "Walks Allowed",
    naturalStep: 0.5,
    dispersionScale: 0.75,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["walks allowed", "pitcher walks", "bases on balls allowed"],
  },
  {
    id: "TOTAL_BASES",
    label: "Total Bases",
    shortLabel: "Total Bases",
    naturalStep: 0.5,
    dispersionScale: 0.75,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["total bases", "bases", "player total bases"],
  },
  {
    id: "HITS",
    label: "Hits",
    shortLabel: "Hits",
    naturalStep: 0.5,
    dispersionScale: 0.5,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["hits", "player hits", "batter hits"],
  },
  {
    id: "RUNS",
    label: "Runs Scored",
    shortLabel: "Runs",
    naturalStep: 0.5,
    dispersionScale: 0.5,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["runs", "runs scored", "player runs"],
  },
  {
    id: "RBIS",
    label: "RBIs",
    shortLabel: "RBIs",
    naturalStep: 0.5,
    dispersionScale: 0.5,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["rbis", "rbi", "runs batted in", "player rbis"],
  },
  {
    id: "HOME_RUNS",
    label: "Home Runs",
    shortLabel: "Home Runs",
    naturalStep: 0.5,
    dispersionScale: 0.5,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["home runs", "hr", "player home runs"],
  },
  {
    id: "STOLEN_BASES",
    label: "Stolen Bases",
    shortLabel: "Stolen Bases",
    naturalStep: 0.5,
    dispersionScale: 0.5,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["stolen bases", "sb", "player stolen bases"],
  },
  {
    id: "STRIKEOUTS_BATTER",
    label: "Strikeouts (Batter)",
    shortLabel: "Batter Ks",
    naturalStep: 0.5,
    dispersionScale: 0.5,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    aliases: ["batter strikeouts", "hitter strikeouts", "strikeouts (batter)"],
  },
  {
    id: "HITS_RUNS_RBIS",
    label: "Hits + Runs + RBIs",
    shortLabel: "H+R+RBI",
    naturalStep: 0.5,
    dispersionScale: 0.75,
    leagues: ["mlb"],
    allowedPeriodIds: ["FULL_GAME"],
    comboComponents: ["HITS", "RUNS", "RBIS"],
    aliases: ["hits + runs + rbis", "hits+runs+rbis", "h+r+rbi", "hits runs rbis"],
  },
];

const MLB_PERIODS: CanonicalPeriod[] = [
  { id: "FULL_GAME", label: "Full Game" },
  { id: "FIRST_5_INNINGS", label: "First 5 Innings" },
  { id: "FIRST_3_INNINGS", label: "First 3 Innings" },
  { id: "FIRST_1_INNING", label: "1st Inning" },
];

const PERIOD_ALIASES: Record<string, string> = {
  "full game": "FULL_GAME",
  game: "FULL_GAME",
  reg: "FULL_GAME",
  "1st 5 innings": "FIRST_5_INNINGS",
  "first 5 innings": "FIRST_5_INNINGS",
  f5: "FIRST_5_INNINGS",
  "first 3 innings": "FIRST_3_INNINGS",
  "1st inning": "FIRST_1_INNING",
  f1: "FIRST_1_INNING",
};

const statById = new Map(MLB_STATS.map((s) => [s.id, s]));
const statByAlias = new Map<string, StatRegistryEntry>();
for (const s of MLB_STATS) {
  statByAlias.set(s.label.toLowerCase(), s);
  for (const a of s.aliases) statByAlias.set(a, s);
}
const periodById = new Map(MLB_PERIODS.map((p) => [p.id, p]));

function toCanonicalStat(e: StatRegistryEntry): CanonicalStat {
  const { id, label, shortLabel, naturalStep, dispersionScale, comboComponents } = e;
  return { id, label, shortLabel, naturalStep, dispersionScale, comboComponents };
}

// Resolve a raw provider stat label to a canonical stat, or null if unknown.
export function resolveStat(raw: string): CanonicalStat | null {
  const key = raw.trim().toLowerCase();
  const hit = statByAlias.get(key);
  return hit ? toCanonicalStat(hit) : null;
}

export function getStatById(id: string): CanonicalStat | null {
  const hit = statById.get(id);
  return hit ? toCanonicalStat(hit) : null;
}

export function resolvePeriod(raw: string): CanonicalPeriod | null {
  const key = raw.trim().toLowerCase();
  const id = PERIOD_ALIASES[key] ?? (periodById.has(raw) ? raw : null);
  return id ? periodById.get(id) ?? null : null;
}

export function getPeriodById(id: string): CanonicalPeriod | null {
  return periodById.get(id) ?? null;
}

// All canonical stats (for the toolbar Stat filter). Canonical taxonomy, not raw
// provider strings (manual §7).
export function listStats(): CanonicalStat[] {
  return MLB_STATS.map(toCanonicalStat);
}

export const DEFAULT_PERIOD: CanonicalPeriod = MLB_PERIODS[0];

// ── SportsGameOdds provider mapping ──────────────────────────────────────────
// Maps the provider's statID (from the oddID `{statID}-{statEntityID}-{periodID}-
// {betTypeID}-{sideID}`) to our canonical stat id. Unknown statIDs resolve to null
// and the odd is skipped (manual §15 — prefer a missing row over a false one).
const PROVIDER_STAT_MAP: Record<string, string> = {
  pitching_strikeouts: "PITCHER_STRIKEOUTS",
  pitching_hits: "HITS_ALLOWED",
  pitching_earnedruns: "EARNED_RUNS",
  pitching_outs: "OUTS_RECORDED",
  pitching_basesonballs: "WALKS_ALLOWED",
  batting_totalbases: "TOTAL_BASES",
  batting_hits: "HITS",
  batting_runs: "RUNS",
  points: "RUNS", // SGO uses `points` for baseball runs
  batting_rbi: "RBIS",
  batting_homeruns: "HOME_RUNS",
  batting_stolenbases: "STOLEN_BASES",
  batting_strikeouts: "STRIKEOUTS_BATTER",
  "batting_hits+runs+rbi": "HITS_RUNS_RBIS",
};

const PROVIDER_PERIOD_MAP: Record<string, string> = {
  game: "FULL_GAME",
  "1i": "FIRST_1_INNING",
  "1ix3": "FIRST_3_INNINGS",
  "1ix5": "FIRST_5_INNINGS",
  "1h": "FIRST_5_INNINGS", // deprecated alias of 1ix5
};

export function resolveProviderStat(statId: string): CanonicalStat | null {
  const canon = PROVIDER_STAT_MAP[statId] ?? PROVIDER_STAT_MAP[statId.toLowerCase()];
  return canon ? getStatById(canon) : null;
}

export function resolveProviderPeriod(periodId: string): CanonicalPeriod | null {
  const id = PROVIDER_PERIOD_MAP[periodId] ?? PROVIDER_PERIOD_MAP[periodId.toLowerCase()];
  return id ? getPeriodById(id) : null;
}
