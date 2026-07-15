// Sport configuration for the arbitrage pipeline. The matching + arb + settlement
// engines are sport-agnostic (they key events by sport:league:teams), so adding a
// sport is just a config entry: which ESPN feed, which Kalshi series, which
// Polymarket tag, which SX.bet league, and how spreads work.

import { fetchESPNGames } from "@/lib/espn";
import { fetchWNBAGames } from "@/lib/wnbaEspn";
import type { Sport } from "@/types/arbitrage";

// Minimal structural game shape the venue adapters need (MLBGame + WNBAGame both satisfy it).
export type ArbGame = {
  id: string;
  date: string;
  startTimeIso: string;
  status: string;
  awayTeam: { name: string; shortName: string; abbreviation: string };
  homeTeam: { name: string; shortName: string; abbreviation: string };
};

export type SportConfig = {
  sport: Sport; // NormalizedMarket.sport
  league: string; // "mlb" | "wnba"
  kalshi: { game: string; total: string; spread: string };
  polyTag: string;
  sxLeagueId: number;
  // Fixed run-line for the spread market (MLB = 1.5). Undefined = variable point
  // spread (WNBA): pick the most liquid line instead of filtering to a fixed one.
  spreadFixedLine?: number;
  fetchGames: (date: string) => Promise<ArbGame[]>;
};

export const SPORTS: SportConfig[] = [
  {
    sport: "baseball",
    league: "mlb",
    kalshi: { game: "KXMLBGAME", total: "KXMLBTOTAL", spread: "KXMLBSPREAD" },
    polyTag: "mlb",
    sxLeagueId: 171,
    spreadFixedLine: 1.5,
    fetchGames: fetchESPNGames,
  },
  {
    sport: "basketball",
    league: "wnba",
    kalshi: { game: "KXWNBAGAME", total: "KXWNBATOTAL", spread: "KXWNBASPREAD" },
    polyTag: "wnba",
    sxLeagueId: 1384,
    spreadFixedLine: undefined, // variable point spread
    fetchGames: fetchWNBAGames,
  },
];
