export type MarketAnalysis = {
  recommendedPick: string;
  confidence: number;         // 1–10
  rating: "safe" | "lean" | "risky" | "avoid";
  isValuePlay: boolean;
  valueScore: number;         // 1–10
  edgeSummary: string;        // one-line reason the price has edge
  reasoning: string;          // 2–4 sentences
  risks: string[];            // 1–3 risk items
};

export type GameAnalysis = {
  gameId: string;
  league: "MLB" | "WNBA";
  summary: string;
  moneyline: MarketAnalysis;
  spread: MarketAnalysis;
  total: MarketAnalysis;
  keyFactors: string[];
  injuryNotes: string[];
  pitcherNotes: string[];
  playerNotes: string[];
  bullpenNotes: string[];
  weatherNotes: string[];
  finalTakeaway: string;
};

export type ValuePlay = {
  gameId: string;
  league: "MLB" | "WNBA";
  awayTeam: string;
  homeTeam: string;
  awayAbbr: string;
  homeAbbr: string;
  startTime: string;
  market: "moneyline" | "spread" | "total";
  analysis: MarketAnalysis;
  fullAnalysis: GameAnalysis;
};
