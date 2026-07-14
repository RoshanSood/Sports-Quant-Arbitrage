// Book catalog for the MLB prop scanner. Column list is configuration-driven
// (manual §2). DFS operators (PrizePicks / Underdog / Sleeper) are anchor-capable;
// the rest are sharp/reference and major sportsbook comparison columns. Real IDs +
// logos are synced from the provider catalog in a later phase; these are the
// canonical display identities the UI and matcher key on.

import type { BookSummary } from "@/types/props";

// Phase 1: sportsbooks are the anchors + comparison columns (book-vs-book line/price
// discrepancies). Phase 2 re-enables the DFS operators as anchors. IDs match the
// SportsGameOdds byBookmaker keys. The sportsbook set mirrors what the MLB feed
// actually returns (DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, Bovada); Pinnacle
// is kept as a sharp reference that appears for regular-season games.
export const BOOKS: BookSummary[] = [
  // Sportsbooks (Phase 1 anchors + comparison)
  { bookId: "draftkings", name: "DraftKings", abbreviation: "DK", category: "sportsbook", anchorCapable: true, displayOrder: 1, logoText: "DK" },
  { bookId: "fanduel", name: "FanDuel", abbreviation: "FD", category: "sportsbook", anchorCapable: true, displayOrder: 2, logoText: "FD" },
  { bookId: "betmgm", name: "BetMGM", abbreviation: "MGM", category: "sportsbook", anchorCapable: true, displayOrder: 3, logoText: "MGM" },
  { bookId: "caesars", name: "Caesars", abbreviation: "CZR", category: "sportsbook", anchorCapable: true, displayOrder: 4, logoText: "CZR" },
  { bookId: "espnbet", name: "ESPN BET", abbreviation: "ESPN", category: "sportsbook", anchorCapable: true, displayOrder: 5, logoText: "EB" },
  { bookId: "bovada", name: "Bovada", abbreviation: "BOV", category: "sportsbook", anchorCapable: true, displayOrder: 6, logoText: "BOV" },
  // Sharp / reference (anchor-capable; typically present for regular-season games)
  { bookId: "pinnacle", name: "Pinnacle", abbreviation: "PIN", category: "sharp", anchorCapable: true, displayOrder: 7, logoText: "PIN" },
  // DFS operators — Phase 2 (no lines in the current feed; kept for when enabled)
  { bookId: "prizepicks", name: "PrizePicks", abbreviation: "PP", category: "dfs", anchorCapable: false, displayOrder: 8, logoText: "PP" },
  { bookId: "underdog", name: "Underdog", abbreviation: "UD", category: "dfs", anchorCapable: false, displayOrder: 9, logoText: "UD" },
  { bookId: "sleeper", name: "Sleeper", abbreviation: "SLP", category: "dfs", anchorCapable: false, displayOrder: 10, logoText: "SL" },
];

const byId = new Map(BOOKS.map((b) => [b.bookId, b]));

export function getBook(bookId: string): BookSummary | undefined {
  return byId.get(bookId);
}

export function anchorBooks(): BookSummary[] {
  return BOOKS.filter((b) => b.anchorCapable);
}

// Comparison columns for a given anchor: everything except the anchor itself, in
// display order (manual §9.3 — anchor is removed from the comparison list).
export function comparisonBooks(anchorBookId: string): BookSummary[] {
  return BOOKS.filter((b) => b.bookId !== anchorBookId).sort((a, b) => a.displayOrder - b.displayOrder);
}

// Phase 1 default anchor is a sportsbook that's actually in the feed. Phase 2 will
// switch this to a DFS operator once those lines are available.
export const DEFAULT_ANCHOR_BOOK_ID = "draftkings";
