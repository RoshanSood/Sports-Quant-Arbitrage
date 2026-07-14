// Shared defaults for the prop scanner (manual §29). Imported by both the API
// bootstrap route and the client so live + mock paths agree.

import type { PropsFilters } from "@/types/props";
import { BOOKS, DEFAULT_ANCHOR_BOOK_ID } from "./books";

export const DEFAULT_FILTERS: PropsFilters = {
  anchorBookId: DEFAULT_ANCHOR_BOOK_ID,
  side: "BOTH",
  statId: "ALL",
  gameDate: "ALL",
  // Phase 1 is an ODDS/arb view driven by raw prices, so it isn't gated on the
  // probability-confidence score (those stay for the Phase-2 fair-prob view).
  minLineGap: 0,
  minHitProbability: null,
  minConfidence: 0,
  arbOnly: false,
  maxHoldPct: null,
  search: "",
  // Phase 1: show sportsbook/sharp columns by default; DFS columns stay available in
  // the Columns menu but hidden (no lines yet). The current anchor is excluded from
  // the comparison columns at render time.
  visibleBookIds: BOOKS.filter((b) => b.category !== "dfs").map((b) => b.bookId),
};

export function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
