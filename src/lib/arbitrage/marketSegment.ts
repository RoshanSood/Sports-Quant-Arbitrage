// Game-segment detection. A book's market title tells you whether it covers the FULL GAME
// or only a SEGMENT (1st 5 innings / F5, a single inning, a half, a period, a quarter).
//
// This matters for arbitrage safety: a segment total (e.g. "1st 5 Innings O/U 2.5") carries
// the SAME numeric line as some full-game total, and the matcher keys on (teams, marketType,
// line) — with no notion of segment. So a Polymarket "1st 5 Innings O/U 2.5" would match a
// Kalshi FULL-GAME "O/U 2.5" as if they were the same market. They settle on different
// outcomes, so it is a FALSE arb that leaves you unhedged. Only full-game markets are
// tradeable here, so each venue's ingest drops anything this flags as a segment.
//
// Patterns target PARTIAL-game indicators only, so ordinary full-game titles ("Over 8.5 runs
// scored", "Team wins by over 1.5 runs", "Padres vs Diamondbacks O/U 8.5", "9 innings",
// "Full Game") are never mis-flagged.

const SEGMENT_PATTERNS: RegExp[] = [
  /\bf5\b/i, // F5 shorthand for first five innings
  /\b(?:1st|first)\s+(?:5|five|3|three)\b/i, // "1st 5 (innings)", "first 5", "1st 3"
  /\b(?:1st|2nd|3rd|[4-9]th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\s+inning\b/i, // a single inning
  /\b(?:1st|2nd|first|second)\s+half\b/i, // halves (soccer / basketball / football)
  /\b[12]h\b/i, // 1H / 2H
  /\b(?:1st|2nd|3rd|first|second|third)\s+period\b/i, // hockey periods
  /\b(?:1st|2nd|3rd|4th|first|second|third|fourth)\s+quarter\b/i, // quarters
  /\bq[1-4]\b/i, // Q1..Q4
];

export type MarketSegment = "full_game" | "segment";

// Classify a market title/question. Anything matching a partial-game pattern is a "segment".
export function marketSegmentOf(title: string | undefined | null): MarketSegment {
  if (!title) return "full_game";
  return SEGMENT_PATTERNS.some((re) => re.test(title)) ? "segment" : "full_game";
}

// True when the title is a full-game market (the only kind we trade / match).
export function isFullGameMarketTitle(title: string | undefined | null): boolean {
  return marketSegmentOf(title) === "full_game";
}
