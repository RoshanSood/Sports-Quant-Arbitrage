export type MarketType = "moneyline" | "spread" | "total";
export type League = "MLB" | "WNBA";
export type OutcomeSide = "away" | "home" | "over" | "under";

export type MarketSnapshot = {
  id: string;
  league: League;
  gameId: string;
  date: string;                // YYYYMMDD
  marketType: MarketType;
  marketId?: string | null;
  conditionId?: string | null;
  matchup: string;             // e.g. "LAA @ TOR"
  outcomeLabel: string;        // e.g. "LAA", "TOR", "O 8.5", "U 8.5"
  outcomeSide: OutcomeSide;
  teamAbbreviation?: string | null;
  price: number | null;        // 0–1 probability
  displayPrice: string;        // e.g. "63¢"
  line?: string | null;        // "+1.5", "-1.5", "8.5"
  capturedAt: string;          // ISO timestamp
};

// Derived — computed from a sorted sequence of snapshots for one market+side
export type PriceHistory = {
  key: string;                 // gameId-marketType-outcomeSide
  gameId: string;
  league: League;
  marketType: MarketType;
  outcomeSide: OutcomeSide;
  matchup: string;
  outcomeLabel: string;
  teamAbbreviation?: string | null;
  line?: string | null;
  history: MarketSnapshot[];   // sorted oldest → newest
  open: MarketSnapshot;
  current: MarketSnapshot;
  previous: MarketSnapshot | null; // second-to-last snapshot (for recent move)
  changeFromOpen: number;      // in 0–1 probability space
  recentChange: number;        // current - previous (0 if no previous)
};

// One entry per game in the line-movement view
export type GameMovement = {
  gameId: string;
  league: League;
  matchup: string;
  startTime: string;
  date: string;
  markets: Record<MarketType, PriceHistory[]>; // per market, array of sides (away/home or over/under)
};
