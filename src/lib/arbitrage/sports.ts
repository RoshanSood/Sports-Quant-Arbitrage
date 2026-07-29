// Sport configuration for the arbitrage pipeline. The matching + arb + settlement
// engines are sport-agnostic (they key events by sport:league:teams), so adding a sport
// is a config entry: where the fixtures come from and, per venue, the identifier that
// venue uses for the league. Every venue field is OPTIONAL — a sport is only fetched from
// the venues that actually carry it (Kalshi/predict.fun don't list soccer or tennis).
//
// Market coverage by sport:
//   • baseball/basketball (MLB/WNBA): totals + moneyline + spread across Kalshi/Poly/SX
//   • soccer (MLS/UCL): 3-way 1X2 moneyline (home/draw/away) — Cloudbet + others
//   • tennis (WTA): 2-way moneyline — Cloudbet + others

import { fetchESPNGames } from "@/lib/espn";
import { fetchWNBAGames } from "@/lib/wnbaEspn";
import { espnTeamGamesFetcher, espnTennisGamesFetcher } from "@/lib/espnSports";
import type { Sport } from "@/types/arbitrage";

// Minimal structural game shape the venue adapters need (MLBGame + WNBAGame both satisfy it).
export type ArbGame = {
  id: string;
  date: string;
  startTimeIso?: string;
  awayTeam: { name: string; shortName: string; abbreviation: string };
  homeTeam: { name: string; shortName: string; abbreviation: string };
};

// Cloudbet feed identifiers for a sport: the moneyline/1X2 market key, plus EITHER a fixed
// competition key (MLS, UCL) OR a live enumeration (sport + key regex) for sports whose
// competitions are per-tournament (WTA). `threeWay` marks a 1X2 (home/draw/away) market so
// the reader emits the draw leg.
export type CloudbetSportCfg = {
  moneyline: string;
  threeWay?: boolean;
  competition?: string;
  sport?: string; // e.g. "tennis" — enumerate /sports/{sport} competitions matching competitionMatch
  competitionMatch?: RegExp;
};

export type SportConfig = {
  sport: Sport; // NormalizedMarket.sport
  league: string; // "mlb" | "wnba" | "mls" | "ucl" | "wta"
  fetchGames: (date: string) => Promise<ArbGame[]>;
  // ESPN scoreboard path for live scores (team sports only). Omit to skip score updates.
  espnScorePath?: string;
  // Which market types to ingest. Soccer/tennis are moneyline-only for now.
  markets: { totals?: boolean; spread?: boolean; moneyline?: boolean };
  // Per-venue league identifiers — omit a venue that doesn't carry the sport.
  kalshi?: { game: string; total: string; spread: string };
  polyTag?: string;
  sxLeagueId?: number; // fixed SX league (MLB/WNBA totals+ml+spread)
  // SX moneyline for sports whose leagues are ephemeral/per-tournament (soccer, tennis):
  // enumerate active leagues live by sportId + label. threeWay = soccer 1X2.
  sxDynamic?: { sportId: number; leagueMatch: RegExp; threeWay?: boolean };
  cloudbet?: CloudbetSportCfg;
  predictfun?: boolean; // predict.fun currently lists MLB moneyline only
  // Fixed run-line for the spread market (MLB = 1.5). Undefined = variable point spread.
  spreadFixedLine?: number;
};

export const SPORTS: SportConfig[] = [
  {
    sport: "baseball",
    league: "mlb",
    fetchGames: fetchESPNGames,
    espnScorePath: "baseball/mlb",
    markets: { totals: true, spread: true, moneyline: true },
    kalshi: { game: "KXMLBGAME", total: "KXMLBTOTAL", spread: "KXMLBSPREAD" },
    polyTag: "mlb",
    sxLeagueId: 171,
    cloudbet: { competition: "baseball-usa-mlb", moneyline: "baseball.moneyline" },
    predictfun: true,
    spreadFixedLine: 1.5,
  },
  {
    sport: "basketball",
    league: "wnba",
    fetchGames: fetchWNBAGames,
    espnScorePath: "basketball/wnba",
    markets: { totals: true, spread: true, moneyline: true },
    kalshi: { game: "KXWNBAGAME", total: "KXWNBATOTAL", spread: "KXWNBASPREAD" },
    polyTag: "wnba",
    sxLeagueId: 1384,
    spreadFixedLine: undefined, // variable point spread
  },
  // ── Soccer (3-way 1X2 moneyline) ────────────────────────────────────────────
  // Cloudbet competition/market keys are best-effort against Cloudbet's documented
  // `{sport}-{category}-{competition}` + `soccer.match_odds` (1X2) scheme; verify once
  // the Cloudbet key is active. Polymarket/SX ids likewise carry these where present.
  {
    sport: "soccer",
    league: "mls",
    fetchGames: espnTeamGamesFetcher("soccer/usa.1"),
    espnScorePath: "soccer/usa.1",
    markets: { moneyline: true },
    polyTag: "mls",
    sxDynamic: { sportId: 5, leagueMatch: /major league soccer/i, threeWay: true }, // SX league 1115
    cloudbet: { competition: "soccer-usa-major-league-soccer", moneyline: "soccer.match_odds", threeWay: true },
  },
  {
    sport: "soccer",
    league: "ucl",
    fetchGames: espnTeamGamesFetcher("soccer/uefa.champions"),
    espnScorePath: "soccer/uefa.champions",
    markets: { moneyline: true },
    polyTag: "champions-league",
    sxDynamic: { sportId: 5, leagueMatch: /champions league/i, threeWay: true }, // SX league 30
    cloudbet: { competition: "soccer-international-clubs-uefa-champions-league", moneyline: "soccer.match_odds", threeWay: true },
  },
  // ── Tennis (2-way moneyline) ─────────────────────────────────────────────────
  {
    sport: "tennis",
    league: "wta",
    fetchGames: espnTennisGamesFetcher("tennis/wta"),
    markets: { moneyline: true },
    polyTag: "tennis",
    sxDynamic: { sportId: 6, leagueMatch: /wta/i }, // all active WTA tournament leagues (2-way)
    // Cloudbet WTA is per-tournament (tennis-wta-*); enumerate + read the 2-way winner.
    cloudbet: { sport: "tennis", competitionMatch: /tennis-wta-/i, moneyline: "tennis.winner" },
  },
];
