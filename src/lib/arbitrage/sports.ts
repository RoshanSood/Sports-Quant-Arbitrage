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
  awayTeam: { name: string; shortName: string; abbreviation: string };
  homeTeam: { name: string; shortName: string; abbreviation: string };
};

// Cloudbet feed identifiers for a sport: the competition key + the moneyline market key.
// `threeWay` marks a 1X2 (home/draw/away) market so the reader emits the draw leg.
export type CloudbetSportCfg = { competition: string; moneyline: string; threeWay?: boolean };

export type SportConfig = {
  sport: Sport; // NormalizedMarket.sport
  league: string; // "mlb" | "wnba" | "mls" | "ucl" | "wta"
  fetchGames: (date: string) => Promise<ArbGame[]>;
  // Which market types to ingest. Soccer/tennis are moneyline-only for now.
  markets: { totals?: boolean; spread?: boolean; moneyline?: boolean };
  // Per-venue league identifiers — omit a venue that doesn't carry the sport.
  kalshi?: { game: string; total: string; spread: string };
  polyTag?: string;
  sxLeagueId?: number;
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
    markets: { moneyline: true },
    polyTag: "mls",
    cloudbet: { competition: "soccer-usa-mls", moneyline: "soccer.match_odds", threeWay: true },
  },
  {
    sport: "soccer",
    league: "ucl",
    fetchGames: espnTeamGamesFetcher("soccer/uefa.champions"),
    markets: { moneyline: true },
    polyTag: "champions-league",
    cloudbet: { competition: "soccer-international-uefa-champions-league", moneyline: "soccer.match_odds", threeWay: true },
  },
  // ── Tennis (2-way moneyline) ─────────────────────────────────────────────────
  {
    sport: "tennis",
    league: "wta",
    fetchGames: espnTennisGamesFetcher("tennis/wta"),
    markets: { moneyline: true },
    polyTag: "tennis",
    cloudbet: { competition: "tennis-wta", moneyline: "tennis.moneyline" },
  },
];
