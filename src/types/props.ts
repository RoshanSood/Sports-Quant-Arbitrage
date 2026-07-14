// Canonical data model for the Player Prop Line Discrepancy Scanner (MLB V1).
// Field sets mirror the Player Prop Scanner manual §6, §14, §18, §21, §24. Kept
// framework-agnostic so the same shapes flow through mock data, provider adapters,
// JSON stores, API routes, and the UI. V1 is READ-ONLY — no entry placement.

// ── Enumerations / unions ────────────────────────────────────────────────────

export type Side = "OVER" | "UNDER";

// Category groups the comparison columns (manual §9.3, §11).
export type BookCategory = "dfs" | "sharp" | "sportsbook";

// Promotional line treatments carried separately from standard-line ranking (§16, §21).
export type PromoTag = "demon" | "goblin" | "boosted" | "discounted" | "protected";

// Per-cell visual state, each backed by a deterministic reason (manual §8, §10).
export type CellState =
  | "best" // best available line/price for the selected side
  | "favorable" // anchor line is easier than consensus
  | "stale" // soft-stale: aged past soft threshold, down-weighted
  | "suspended" // market temporarily unavailable, excluded from consensus
  | "outlier" // diverges beyond the dispersion gate, excluded
  | "low_confidence"; // insufficient exact-line / identity evidence

// Row / group reason codes (manual §21). Drive row accents and audit logs.
export type ReasonCode =
  | "FAVORABLE_LINE_GAP"
  | "HIGH_HIT_PROBABILITY"
  | "SAME_LINE_PRICE_GAP"
  | "MARKET_OUTLIER"
  | "STALE_QUOTE"
  | "HARD_STALE_QUOTE"
  | "PERIOD_MISMATCH"
  | "PLAYER_MATCH_AMBIGUOUS"
  | "PROMO_LINE"
  | "INSUFFICIENT_MARKET_DATA";

export type RowFlag = ReasonCode;

export type DiscrepancyReason = "LINE_GAP" | "PRICE_GAP" | "BOTH" | "INSUFFICIENT_DATA";

export type MatchRejectReason =
  | "PLAYER_MATCH_AMBIGUOUS"
  | "EVENT_MISMATCH"
  | "STAT_TAXONOMY_MISMATCH"
  | "PERIOD_MISMATCH"
  | "SIDE_UNMAPPABLE"
  | "MALFORMED_LINE";

export type ProviderStatus = "healthy" | "degraded" | "down" | "stale";

// ── Registry-resolved descriptors ────────────────────────────────────────────

// A canonical stat, resolved from the registry (manual §16). Carried on the row so
// the UI never re-parses raw provider strings.
export type CanonicalStat = {
  id: string; // e.g. "PITCHER_STRIKEOUTS"
  label: string; // full display label
  shortLabel: string; // compact label for the Stat column (≤3 short lines)
  naturalStep: number; // smallest meaningful line move (e.g. 0.5)
  dispersionScale?: number; // stat-specific scale for the line z-score
  comboComponents?: string[]; // sorted component stat ids for combo props
};

// Canonical period. Full game vs partial periods must never mix (manual §14, §16).
export type CanonicalPeriod = {
  id: string; // "FULL_GAME" | "FIRST_5_INNINGS" | ...
  label: string;
};

// ── Player / event summaries (manual §4, §6) ─────────────────────────────────

export type PlayerSummary = {
  participantId: string;
  name: string;
  team: string; // player's team abbreviation
  position?: string;
  headshotUrl?: string | null; // null → fallback silhouette
};

export type EventSummary = {
  eventId: string;
  sport: string; // "baseball"
  league: string; // "mlb"
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO
  matchupLabel: string; // e.g. "NYY @ BOS"
};

// ── Quote shapes (manual §14) ────────────────────────────────────────────────

// The UI-facing quote for a single book cell. A DFS operator may quote a line
// without an American price (americanOdds null); never invent one.
export type DisplayQuote = {
  quoteId: string;
  bookId: string;
  side: Side;
  line: number;
  americanOdds: number | null;
  decimalOdds?: number | null;
  multiplier?: number | null; // DFS payout multiplier, stored separately from odds
  promo?: PromoTag | null;
  maxStakeUsd?: number | null; // limit badge; hidden when unknown
  available: boolean;
  isMainLine?: boolean;
  sourceUpdatedAt?: string | null;
  observedAt: string;
  sourceUrl?: string | null; // provider-supplied deeplink, when available
  cellState?: CellState | null;
};

// The canonical backend quote (manual §14). Raw provider payload retained only for
// debugging / parser migrations.
export type Quote = {
  quoteId: string;
  propId: string;
  providerId: string;
  bookId: string;
  side: Side;
  line: number;
  americanOdds?: number;
  decimalOdds?: number;
  rawImpliedProbability?: number;
  multiplier?: number;
  promo?: PromoTag | null;
  maxStakeUsd?: number;
  available: boolean;
  isMainLine?: boolean;
  sourceUpdatedAt?: string;
  observedAt: string;
  sourceUrl?: string;
  raw?: unknown;
};

export type CanonicalProp = {
  propId: string;
  eventId: string;
  participantId: string;
  sport: string;
  league: string;
  stat: CanonicalStat;
  period: CanonicalPeriod;
  unit?: string;
  comboParticipants?: string[];
};

// ── Discrepancy + ranking (manual §18, §19) ──────────────────────────────────

export type DiscrepancySummary = {
  anchorLine: number;
  consensusLine: number | null;
  // Positive → the anchor line is EASIER for the selected side.
  directionalLineEdge: number | null;
  lineZScore: number | null;
  marketHitProbability: number | null;
  breakEvenProbability: number | null;
  probabilityEdge: number | null;
  dispersion: number | null;
  score: number; // rankScore 0–100
  reason: DiscrepancyReason;
};

// Audit surface for the detail drawer (manual §9, §22, §24). Every visible value
// must be reproducible from these quote IDs + method version.
export type CalculationTrace = {
  methodVersion: string;
  includedQuoteIds: string[];
  rejectedQuoteIds: { quoteId: string; reason: MatchRejectReason | ReasonCode }[];
  thresholds: Record<string, number>;
  confidenceComponents: Record<string, number>;
  ladderPoints?: { bookId: string; line: number; probability: number }[];
};

// ── Two-way cross-book arbitrage (odds discrepancy) ──────────────────────────

export type ArbLegPick = {
  bookId: string;
  american: number;
  decimal: number;
  impliedProb: number;
  available: boolean;
};

export type TwoWayArb = {
  line: number;
  over: ArbLegPick | null;
  under: ArbLegPick | null;
  combinedImplied: number | null; // over.impliedProb + under.impliedProb
  edgePct: number | null; // (1 - combinedImplied) * 100; > 0 ⇒ guaranteed arb
  holdPct: number | null; // (combinedImplied - 1) * 100; the two-way vig
  isArb: boolean;
  stake: { overPct: number; underPct: number } | null;
  bothAvailable: boolean;
};

// ── The materialized grid row (manual §6) ────────────────────────────────────

export type PropsGridRow = {
  rowId: string;
  player: PlayerSummary;
  event: EventSummary;
  stat: CanonicalStat;
  period: CanonicalPeriod;
  side: Side;
  anchor: DisplayQuote;
  fairHitProbability: number | null; // consensus fair probability (0–1)
  fairAmericanOdds: number | null; // derived from fairHitProbability
  confidence: number; // 0–1 quality score
  discrepancy: DiscrepancySummary;
  // Odds view: the two-way arb for this prop's line, and the best price for the
  // row's side (kept for compatibility; the two-way row uses arb.over / arb.under).
  arb: TwoWayArb | null;
  bestPrice: ArbLegPick | null;
  cellsByBookId: Record<string, DisplayQuote | null>; // null → intentionally blank
  // Both sides per book at the arb line — the true-arb row shows over + under
  // together and highlights the book to BET on each side.
  twoWayCells: Record<string, TwoWayCell>;
  flags: RowFlag[];
  trace?: CalculationTrace;
};

// A book's over + under quotes at the row's line (either may be missing).
export type TwoWayCell = { over: DisplayQuote | null; under: DisplayQuote | null };

// ── Catalog / health / realtime (manual §24) ─────────────────────────────────

export type BookSummary = {
  bookId: string;
  name: string;
  abbreviation: string;
  category: BookCategory;
  anchorCapable: boolean; // PrizePicks / Underdog / Sleeper
  displayOrder: number;
  logoText?: string; // short glyph/abbr fallback when no logo asset
};

export type ProviderHealth = {
  providerId: string;
  status: ProviderStatus;
  lastSuccessAt: string | null;
  latencyMs: number | null;
  activeEvents: number;
  message?: string;
};

export type PropsRowDelta =
  | { type: "upsert"; row: PropsGridRow; version: number }
  | { type: "remove"; rowId: string; version: number }
  | { type: "health"; provider: ProviderHealth }
  | { type: "catalog"; books: BookSummary[] };

// ── Client-side filter/sort state (manual §7, §29) ───────────────────────────

export type PropsFilters = {
  anchorBookId: string;
  side: Side | "BOTH";
  statId: string | "ALL";
  gameDate: string | "ALL"; // YYYY-MM-DD (game's PT calendar date) or ALL
  minLineGap: number;
  minHitProbability: number | null;
  minConfidence: number;
  arbOnly: boolean; // show only rows where the 2-way market is a locked arb
  maxHoldPct: number | null; // hide rows whose 2-way hold exceeds this (null = no cap)
  search: string;
  visibleBookIds: string[]; // order + visibility of comparison columns
};

export type PropsBootstrap = {
  date: string;
  rows: PropsGridRow[];
  books: BookSummary[];
  health: ProviderHealth[];
  filters: PropsFilters;
  generatedAt: string;
};
