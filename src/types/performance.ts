export type League = "MLB" | "WNBA";
export type MarketType = "moneyline" | "spread" | "total";
export type PickSide = "away" | "home" | "over" | "under";
export type RecommendationStatus = "pending" | "win" | "loss" | "push" | "void";
export type ClaudeRating = "safe" | "lean" | "risky" | "avoid";
export type RecommendationSource = "value_plays" | "game_analysis" | "manual_analysis";

export type TrackedRecommendation = {
  id: string;              // `${date}-${gameId}-${market}-${pickSide}-${shortRandom}`
  gameId: string;
  league: League;
  date: string;            // YYYYMMDD
  startTime: string;

  awayTeam: { name: string; abbreviation: string };
  homeTeam: { name: string; abbreviation: string };

  marketType: MarketType;
  recommendedPick: string; // e.g. "TOR", "LAA +1.5", "O 8.5"
  pickSide: PickSide;
  line?: string | null;    // "+1.5" or "8.5" (numeric line as string)

  price: number | null;    // 0-1 probability
  displayPrice: string | null;

  confidence: number;      // 1-10
  rating: ClaudeRating;
  valueScore?: number | null;

  reasoningSummary: string;
  risks: string[];

  source: RecommendationSource;
  generatedAt: string;     // ISO timestamp

  status: RecommendationStatus;

  finalScore?: { away: number; home: number } | null;
  closingPrice?: number | null;
  closingDisplayPrice?: string | null;
  closingLineValue?: number | null;

  gradedAt?: string | null;
  gradingNotes?: string | null;
};

// ── Derived stats ─────────────────────────────────────────────────────────────

export type RecordStats = {
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  winRate: number;   // wins / (wins + losses), 0-1
  unitsPL: number;   // net units P&L (each bet risks 1 unit, wins (1-p)/p)
  roi: number;       // unitsPL / gradedBets * 100 (%)
};

export type PerformanceBreakdown = {
  overall: RecordStats;
  byLeague: Record<League, RecordStats>;
  byMarket: Record<MarketType, RecordStats>;
  byConfidence: {
    high: RecordStats;   // confidence 8-10
    medium: RecordStats; // confidence 6-7
    low: RecordStats;    // confidence 1-5
  };
  byRating: Record<ClaudeRating, RecordStats>;
  avgConfidenceWins: number | null;
  avgConfidenceLosses: number | null;
};

export type GradeResult = {
  id: string;
  status: RecommendationStatus;
  finalScore?: { away: number; home: number };
  gradingNotes: string;
};

// ── Mock bankroll tracking ─────────────────────────────────────────────────────

export type BankrollBet = {
  recId: string;
  date: string;            // YYYYMMDD
  game: string;            // "TOR @ NYY"
  pick: string;
  marketType: MarketType;
  confidence: number;
  units: number;           // 0.5 / 1 / 1.5 / 2
  betAmount: number;       // units × unitSize in $
  price: number | null;    // Polymarket 0-1 probability
  displayPrice: string | null;
  status: RecommendationStatus;
  profit: number | null;   // null while pending; computed on settlement
  placedAt: string;        // ISO timestamp
  settledAt: string | null;
};

export type DayBankrollSummary = {
  date: string;
  startingBalance: number;
  dayProfit: number;
  bets: BankrollBet[];
  pendingCount: number;
  settledCount: number;
  totalBetAmount: number;
};

export type BankrollData = {
  startingBalance: number;
  unitSize: number;
  currentBalance: number;
  totalProfit: number;
  totalProfitPct: number;
  availableDates: string[];
  bets: BankrollBet[];
  dayData: DayBankrollSummary | null;
};
