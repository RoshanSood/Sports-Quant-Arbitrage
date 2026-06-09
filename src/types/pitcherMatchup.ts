export type PitcherHand = "RHP" | "LHP" | "Unknown";

export type PitcherBasicInfo = {
  id: number | null;
  fullName: string;
  teamName: string;
  teamAbbreviation: string;
  throws: PitcherHand;
  age?: number | null;
  headshot?: string | null;
};

export type PitcherSeasonStats = {
  era?: string | null;
  whip?: string | null;
  wins?: number | null;
  losses?: number | null;
  gamesStarted?: number | null;
  inningsPitched?: string | null;
  strikeouts?: number | null;
  walks?: number | null;
  hitsAllowed?: number | null;
  homeRunsAllowed?: number | null;
  earnedRuns?: number | null;
  battingAverageAgainst?: string | null;
  strikeoutsPer9?: string | null;
  walksPer9?: string | null;
  homeRunsPer9?: string | null;
  strikeoutWalkRatio?: string | null;
};

export type PitcherGameLogEntry = {
  date: string;
  opponent: string;
  inningsPitched?: string | null;
  earnedRuns?: number | null;
  hitsAllowed?: number | null;
  walks?: number | null;
  strikeouts?: number | null;
  homeRunsAllowed?: number | null;
  pitchesThrown?: number | null;
  decision?: string | null;
};

export type FormLabel = "Strong" | "Solid" | "Average" | "Volatile" | "Risky" | "Unknown";

export type PitcherRecentForm = {
  last3Starts: PitcherGameLogEntry[];
  last5Starts: PitcherGameLogEntry[];
  last3Summary: {
    inningsPitched?: string | null;
    earnedRuns?: number | null;
    strikeouts?: number | null;
    walks?: number | null;
    homeRunsAllowed?: number | null;
    era?: string | null;
    whip?: string | null;
  };
  formLabel: FormLabel;
};

export type PitchingEdge = "away" | "home" | "push";
export type MarketImpact = "away" | "home" | "neutral";
export type TotalImpact = "over" | "under" | "neutral";

export type PitcherMatchupAnalysis = {
  edge: PitchingEdge;
  edgeLabel: string;             // e.g. "Cubs" or "Push"
  edgeSummary: string;
  awayPitcherAssessment: string;
  homePitcherAssessment: string;
  moneylineImpact: MarketImpact;
  spreadImpact: MarketImpact;
  totalImpact: TotalImpact;
  totalImpactReason: string;
  keyFactors: string[];
  bettingConclusion: string;
};

export type PitcherMatchupData = {
  gameId: string;
  date: string;
  awayTeam: {
    name: string;
    abbreviation: string;
    pitcher: PitcherBasicInfo | null;
  };
  homeTeam: {
    name: string;
    abbreviation: string;
    pitcher: PitcherBasicInfo | null;
  };
  awayPitcherStats: PitcherSeasonStats | null;
  homePitcherStats: PitcherSeasonStats | null;
  awayPitcherRecentForm: PitcherRecentForm | null;
  homePitcherRecentForm: PitcherRecentForm | null;
  analysis: PitcherMatchupAnalysis | null;
};
