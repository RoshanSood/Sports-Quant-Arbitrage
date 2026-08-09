// Game-segment detection from a venue's raw market title/question.
//
// A book's title tells you whether a market covers the FULL GAME or only a SEGMENT
// (1st 5 innings / F5, a single inning, a half, a period, a quarter). This matters for
// arbitrage safety: a segment market can carry the SAME line number as a full-game market
// (e.g. both a full-game total and an F5 total might be "O/U 8.5"), so without this check
// the matcher would pair them as if they were the same market — a false arb that settles on
// different outcomes and leaves you unhedged.
//
// "f5" (first 5 innings, MLB) is a supported, TRADEABLE segment — Kalshi and Polymarket both
// carry full F5 market ladders (moneyline/total/spread), so F5 markets are ingested and
// matched against each other (never against full-game). Every other partial-game segment
// (single innings, halves, periods, quarters, F3/F7) has no matching infrastructure here, so
// classifyMarketSegment returns null for those and the caller excludes them entirely.
import type { MarketSegment } from "@/types/arbitrage";

const F5_PATTERNS: RegExp[] = [
  /\bf5\b/i,
  /\b(?:1st|first)\s+(?:5|five)\b/i, // "1st 5 (innings)", "first 5"
  /\bafter\s+5\s+innings\b/i, // Polymarket F5 winner/tie: "winning after 5 innings?", "Tied after 5 innings?"
];

// Other partial-game segments this app does NOT support matching for — excluded entirely.
const OTHER_SEGMENT_PATTERNS: RegExp[] = [
  /\bf3\b/i,
  /\b(?:1st|first)\s+(?:3|three)\b/i,
  /\bf7\b/i,
  /\b(?:1st|first)\s+(?:7|seven)\b/i,
  /\b(?:1st|2nd|3rd|[4-9]th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\s+inning\b/i, // a single inning
  /\b(?:1st|2nd|first|second)\s+half\b/i, // halves (soccer / basketball / football)
  /\b[12]h\b/i, // 1H / 2H
  /\b(?:1st|2nd|3rd|first|second|third)\s+period\b/i, // hockey periods
  /\b(?:1st|2nd|3rd|4th|first|second|third|fourth)\s+quarter\b/i, // quarters
  /\bq[1-4]\b/i, // Q1..Q4
];

// Classify a market title/question. Returns "full_game" (default — no segment indicator),
// "f5" (first-5-innings, tradeable), or null (an unsupported partial segment — exclude).
export function classifyMarketSegment(title: string | undefined | null): MarketSegment | null {
  if (!title) return "full_game";
  if (F5_PATTERNS.some((re) => re.test(title))) return "f5";
  if (OTHER_SEGMENT_PATTERNS.some((re) => re.test(title))) return null;
  return "full_game";
}

// True when the title is a full-game market (no segment indicator at all).
export function isFullGameMarketTitle(title: string | undefined | null): boolean {
  return classifyMarketSegment(title) === "full_game";
}
