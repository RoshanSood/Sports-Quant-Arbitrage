// Data models for the standalone cross-venue arbitrage module ("Claw Arbs").
// Field sets mirror the arbitrage manual §6 (Data Models). Kept framework-agnostic
// so the same shapes flow through mock data, JSON stores, API routes, and the UI.

// ── Enumerations / unions ────────────────────────────────────────────────────

export type VenueId = string;

export type VenueType = "prediction_market" | "sportsbook" | "exchange";
export type VenueRole = "sharp" | "primary" | "hedge" | "reference";
export type VenueStatus =
  | "connected"
  | "degraded"
  | "disconnected"
  | "credential_needed"
  | "disabled";

export type Sport = "baseball" | "basketball" | "football" | "hockey" | "other";
export type MarketType = "moneyline" | "spread" | "total";
export type Outcome = "yes" | "no" | "over" | "under" | "home" | "away";
export type Currency = "USD" | "USDC" | "USDT";

export type TradeMode = "paper" | "live";

export type OpportunityStatus =
  | "open"
  | "tracked"
  | "executing"
  | "filled"
  | "expired"
  | "rejected";

export type FillStatus = "unfilled" | "partial" | "filled" | "failed";

export type TradeStatus =
  | "open"
  | "closed"
  | "failed"
  | "partial"
  | "naked"
  | "settled"
  | "cancelled";

export type SizingMethod = "equal_profit" | "fixed" | "proportional";

export type StrategyType = "arbitrage" | "value";

// Deterministic halt/decision reason codes (manual §13 + execution codes §18).
export type ReasonCode =
  | "position_dedup"
  | "identity_dedup"
  | "stale_quote"
  | "insufficient_depth"
  | "insufficient_balance"
  | "edge_below_min"
  | "edge_above_max"
  | "market_suspended"
  | "orderbook_not_ready"
  | "hedge_failed"
  // execution-pipeline codes
  | "agent_disabled"
  | "kill_switch"
  | "venue_view_only"
  | "exposure_exceeded"
  | "final_refresh_failed"
  | "naked_position";

export type ArbResult = "executed" | "halted" | "failed" | "partial" | "naked";

// ── Supporting shapes ────────────────────────────────────────────────────────

export type FeeModel = "kalshi_tier" | "polymarket_flat" | "sxbet_flat" | "placeholder";

export type FeeBreakdown = {
  venueId: VenueId;
  feeCents: number; // fee attributable to this leg, in cents
  feeRate: number; // effective rate as a fraction (e.g. 0.0075)
  model: FeeModel;
};

export type ArbLeg = {
  venueId: VenueId;
  marketId: string;
  outcome: Outcome;
  priceCents: number; // executable price in cents (0-100)
  decimalOdds: number; // 100 / priceCents
  impliedProbability: number; // priceCents / 100
  size: number; // contracts / shares
  feeCents: number; // fee for this leg in cents
  liquidityUsd?: number; // executable $ available at the ask (top of book)
  label?: string; // human-readable, e.g. "NO (under 6.5)"
  // Venue-NATIVE order identifier (Kalshi ticker, Polymarket tokenId, SX marketHash)
  // + native side. Required to place a REAL order; absent on synthetic/paper legs, in
  // which case live execution refuses to fire.
  nativeMarketId?: string;
  nativeSide?: string;
};

export type StakePlan = {
  method: SizingMethod;
  totalStake: number; // dollars committed across all legs
  legSizes: Record<VenueId, number>; // dollars per venue leg
  guaranteedPayout: number;
  expectedProfit: number; // net profit in dollars
  profitPerLeg: number; // for equal-profit sizing, ~constant across outcomes
};

// ── Core models (manual §6) ──────────────────────────────────────────────────

export type Venue = {
  id: VenueId;
  name: string;
  type: VenueType;
  role: VenueRole;
  currency: Currency;
  status: VenueStatus;
  enabled: boolean;
  viewOnly: boolean;
  supportsCancel: boolean;
  supportsPartialFill: boolean;
  isIrreversible: boolean;
  // Presentational / diagnostic extras (optional)
  abbr?: string;
  color?: string;
  activeEdges?: number;
  cachedTickers?: number;
  freshness?: "live" | "stale" | "unknown";
  lastUpdate?: string; // ISO timestamp
};

export type NormalizedMarket = {
  venueId: VenueId;
  marketId: string;
  // Venue-native order identifier + side (Kalshi ticker + yes/no, etc.) — carried so
  // real execution can place a correct order rather than parse the synthetic marketId.
  nativeMarketId?: string;
  nativeSide?: string;
  sport: Sport;
  league: string;
  startTime: string; // ISO timestamp
  teams: [string, string]; // [away, home]
  marketType: MarketType;
  line: number | null; // total/spread line; null for moneyline
  outcome: Outcome;
  priceCents: number;
  decimalOdds: number;
  impliedProbability: number;
  depth: number; // executable contracts at the ask (top of book)
  liquidityUsd: number; // executable $ at the ask (top of book)
  live: boolean;
  status: "open" | "suspended" | "closed" | "settled";
  lastUpdated: string; // ISO timestamp
};

export type MatchKey = {
  sport: Sport;
  league: string;
  startWindow: string; // bucketed start time, e.g. "2026-07-07T23:05Z"
  canonicalTeams: [string, string];
  homeAway: "home_away" | "unknown";
  marketType: MarketType;
  line: number | null;
  outcomeGroup: "two_way" | "three_way";
  confidence: number; // 0-1 match confidence
};

// ── Matching engine outputs (manual §5) ──────────────────────────────────────

export type MatchRejectReason =
  | "match_confidence_low"
  | "line_mismatch"
  | "same_outcome"
  | "self_edge"
  | "start_time_window"
  | "identity_dedup";

// One venue's quote inside a matched event.
export type MatchedLeg = {
  venueId: VenueId;
  marketId: string;
  nativeMarketId?: string;
  nativeSide?: string;
  outcome: Outcome; // OVER/UNDER for totals, HOME/AWAY for moneyline
  line: number;
  priceCents: number;
  decimalOdds: number;
  impliedProbability: number;
  liquidityUsd: number; // executable $ at the ask
  label: string; // human-readable side, e.g. "over 6.5" or team name
};

// A cross-venue matched market at a single agreed line.
export type MatchedEvent = {
  eventKey: string;
  matchup: string; // "Away v Home"
  sport: Sport;
  league: string;
  startWindow: string;
  canonicalTeams: [string, string]; // [away, home]
  marketType: MarketType;
  line: number;
  venues: VenueId[];
  legs: MatchedLeg[];
  confidence: number; // 0-1
};

export type MatchReject = {
  eventKey: string;
  matchup: string;
  marketType: MarketType;
  reason: MatchRejectReason;
  detail: string;
};

export type MatchStats = {
  matched: number;
  byVenue: Record<VenueId, number>;
  byVenuePair: Record<string, number>; // "kalshi+polymarket" -> count
  dedupDropped: number;
  selfEdgeDropped: number;
  lineMismatch: number;
  invariantRejected: number;
};

export type MatchMapData = {
  matched: MatchedEvent[];
  rejects: MatchReject[];
  stats: MatchStats;
};

// One game's main total line, monitored live even when there's no tradeable arb.
export type MainLineWatch = {
  eventKey: string;
  matchup: string;
  line: number;
  venuePrices: { venueId: VenueId; overCents: number | null; underCents: number | null }[];
  totalCostCents: number; // cheapest cross-venue over + under
  grossEdge: number; // may be <= 0
  netEdge: number; // may be <= 0
  divergenceCents: number; // cross-venue over-price disagreement
  liquidityUsd: number; // min executable $ across the two legs
  status: "arb" | "no_edge" | "stale";
};

export type ArbOpportunity = {
  id: string;
  eventKey: string; // e.g. baseball:mlb:phillies:reds:2026-07-07T23:05Z:total:6.5
  matchup: string; // human-readable, e.g. "Phillies v Reds"
  marketType: MarketType;
  line: number | null;
  legs: ArbLeg[];
  totalCostCents: number; // sum of leg priceCents
  grossEdge: number; // fraction, (100 - totalCost) / totalCost
  netEdge: number; // fraction, gross minus fees and slippage
  fees: FeeBreakdown[];
  depthLimit: number; // max executable contracts across both legs
  stakePlan: StakePlan;
  quoteFreshness: number; // ms since quotes captured
  agentId: string;
  status: OpportunityStatus;
  detectedAt: string; // ISO timestamp
};

export type Trade = {
  id: string;
  mode: TradeMode;
  opportunityId: string;
  agentId: string;
  matchup: string;
  legs: ArbLeg[];
  orderIds: (string | null)[];
  fillStatus: FillStatus;
  totalCost: number; // dollars
  expectedProfit: number; // dollars
  realizedPnl: number | null; // dollars, null while open
  netEdge: number; // fraction at entry
  clvDrift: number | null; // closing-line-value drift, fraction
  status: TradeStatus;
  openedAt: string; // ISO timestamp
  closedAt: string | null;
  date: string; // YYYYMMDD (storage key)
  finalScore?: { away: number; home: number }; // set at settlement
  nakedLegIndex?: number; // for naked positions, which leg actually filled
};

export type ArbLog = {
  id: string;
  time: string; // ISO timestamp
  pair: string; // "[CB:kalshi-mlb] Phillies v Reds"
  venues: VenueId[];
  edge: number; // fraction
  mode: TradeMode;
  agent: string; // agent id/name
  result: ArbResult;
  reasonCode: ReasonCode | null;
  reason: string; // human-readable
  detailsJson: Record<string, unknown>;
  date: string; // YYYYMMDD (storage key)
};

// ── Agent + risk (not in §6 table but required for the default agent + risk panel)

export type Agent = {
  id: string;
  name: string;
  strategy: StrategyType;
  enabled: boolean;
  paper: boolean; // paper trading on
  live: boolean; // live execution enabled
  autoTrade: boolean; // auto-fill qualifying paper arbs without a manual Play
  minEdge: number; // fraction, default 0.005
  maxEdge: number; // fraction, default 0.25
  sizingMethod: SizingMethod;
  maxStake: number; // dollars, user cap per arb
  venues: VenueId[];
  staleQuoteMs: number;
};

export type RiskSettings = {
  killSwitch: boolean;
  maxExposure: number; // dollars across all open positions
  currentExposure: number; // dollars
  maxDailyLoss: number; // dollars
  dailyPnl: number; // dollars
  maxOpenPositions: number;
  pauseOnNaked: boolean;
  staleQuoteMs: number;
  minLiquidityUsd: number; // drop legs with less executable $ than this (manual §13)
  maxLiveStakeUsd: number; // hard cap on $ any single LIVE trade may commit (UI-configured)
  perVenueCap: Record<VenueId, number>;
};

// ── Aggregations for API responses ───────────────────────────────────────────

export type PortfolioSummary = {
  mode: TradeMode;
  bankroll: number;
  startingBankroll: number;
  totalPnl: number;
  unrealizedPnl: number;
  exposure: number;
  maxExposure: number;
  openCount: number;
  totalCount: number;
  winRate: number; // 0-1
  maxPerArb: number;
  positions: Trade[];
};
