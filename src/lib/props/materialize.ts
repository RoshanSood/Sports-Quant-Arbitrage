// Materializer (manual §6, §10). Groups canonical prop quotes and emits ONE true-arb
// row per prop: it picks the line with the best two-sided coverage, computes the
// two-way cross-book arb there (best over price + best under price), and builds a
// per-book over/under cell map. The two books that make the arb (best over, best
// under) are tagged so the UI can highlight exactly what to bet. The fair-value
// consensus is still computed for the drawer + Phase 2.

import type { CellState, DisplayQuote, PropsGridRow, Side, TwoWayCell } from "@/types/props";
import { BOOKS, getBook } from "./books";
import { computeTwoWayArb, type ArbLegInput } from "./arb";
import { computeConsensus } from "./consensus";
import type { PropQuote } from "./normalize";

function pickClosest(quotes: PropQuote[], line: number): PropQuote | null {
  if (!quotes.length) return null;
  return quotes.reduce((best, q) => (Math.abs(q.line - line) < Math.abs(best.line - line) ? q : best));
}

function toDisplayQuote(q: PropQuote, cellState: CellState | null): DisplayQuote {
  const isDfs = getBook(q.bookId)?.category === "dfs";
  return {
    quoteId: q.quoteId,
    bookId: q.bookId,
    side: q.side,
    line: q.line,
    americanOdds: q.americanOdds,
    multiplier: isDfs ? 1 : undefined,
    available: q.available,
    observedAt: q.observedAt,
    sourceUpdatedAt: q.sourceUpdatedAt,
    cellState,
  };
}

// Best-price legs across ALL books at exactly `line` for a side.
function legsAtLine(group: PropQuote[], side: Side, line: number): ArbLegInput[] {
  return group
    .filter((q) => q.side === side && Math.abs(q.line - line) < 1e-9 && q.americanOdds != null)
    .map((q) => ({ bookId: q.bookId, american: q.americanOdds, available: q.available }));
}

// The line with the best two-sided book coverage — where a same-line arb is most
// likely (books must share a line to arb it).
function pickArbLine(group: PropQuote[]): number | null {
  const overByLine = new Map<number, Set<string>>();
  const underByLine = new Map<number, Set<string>>();
  for (const q of group) {
    if (q.americanOdds == null) continue;
    const m = q.side === "OVER" ? overByLine : underByLine;
    (m.get(q.line) ?? m.set(q.line, new Set()).get(q.line)!).add(q.bookId);
  }
  let best: number | null = null;
  let bestScore = -1;
  for (const line of new Set([...overByLine.keys(), ...underByLine.keys()])) {
    const o = overByLine.get(line)?.size ?? 0;
    const u = underByLine.get(line)?.size ?? 0;
    const score = Math.min(o, u) * 1000 + (o + u); // prioritize two-sided coverage
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return best;
}

export function materializeRows(quotes: PropQuote[], now = Date.now(), minLineGap = 0.5): PropsGridRow[] {
  const groups = new Map<string, PropQuote[]>();
  for (const q of quotes) {
    (groups.get(q.canonicalKey) ?? groups.set(q.canonicalKey, []).get(q.canonicalKey)!).push(q);
  }

  const rows: PropsGridRow[] = [];

  for (const [canonicalKey, group] of groups) {
    const line = pickArbLine(group);
    if (line == null) continue;

    const arb = computeTwoWayArb(legsAtLine(group, "OVER", line), legsAtLine(group, "UNDER", line), line);
    if (!arb.over || !arb.under) continue; // need a genuine two-way market

    const consensus = computeConsensus({
      quotes: group,
      side: "OVER",
      anchorLine: line,
      anchorBookId: arb.over.bookId,
      stat: group[0].stat,
      now,
      minLineGap,
    });

    // Per-book over/under cells at the line. Tag the best-over and best-under books
    // "best" (BET), and mark suspended/stale/outlier otherwise.
    const twoWayCells: Record<string, TwoWayCell> = {};
    const cellsByBookId: Record<string, DisplayQuote | null> = {}; // over cells (drawer compat)
    for (const book of BOOKS) {
      const overQ = pickClosest(group.filter((q) => q.bookId === book.bookId && q.side === "OVER"), line);
      const underQ = pickClosest(group.filter((q) => q.bookId === book.bookId && q.side === "UNDER"), line);
      // BET legs stay "best" (green) even when suspended — availability is carried on
      // the quote and dims the cell in the UI, so the recommendation stays visible.
      const stateFor = (q: PropQuote | null, isBet: boolean): CellState | null => {
        if (!q) return null;
        if (consensus.outlierQuoteIds.has(q.quoteId)) return "outlier";
        if (consensus.staleQuoteIds.has(q.quoteId)) return "stale";
        if (isBet) return "best";
        if (!q.available) return "suspended";
        return null;
      };
      const over = overQ ? toDisplayQuote(overQ, stateFor(overQ, book.bookId === arb.over!.bookId)) : null;
      const under = underQ ? toDisplayQuote(underQ, stateFor(underQ, book.bookId === arb.under!.bookId)) : null;
      twoWayCells[book.bookId] = { over, under };
      cellsByBookId[book.bookId] = over;
    }

    const anchor: DisplayQuote = {
      quoteId: `line-${canonicalKey}`,
      bookId: "",
      side: "OVER",
      line,
      americanOdds: null,
      available: true,
      observedAt: group[0].observedAt,
      isMainLine: true,
    };

    rows.push({
      rowId: canonicalKey,
      player: group[0].player,
      event: group[0].event,
      stat: group[0].stat,
      period: group[0].period,
      side: "OVER", // placeholder: the two-way row is sideless
      anchor,
      fairHitProbability: consensus.fairHitProbability,
      fairAmericanOdds: consensus.fairAmericanOdds,
      confidence: consensus.confidence,
      discrepancy: consensus.discrepancy,
      arb,
      bestPrice: arb.over,
      cellsByBookId,
      twoWayCells,
      flags: consensus.flags,
      trace: consensus.trace,
    });
  }

  // Tightest two-way market first (arbs, then lowest hold), ties by soonest event.
  const edge = (r: PropsGridRow) => r.arb?.edgePct ?? -1e9;
  rows.sort((a, b) => {
    if (edge(b) !== edge(a)) return edge(b) - edge(a);
    return new Date(a.event.startTime).getTime() - new Date(b.event.startTime).getTime();
  });

  return rows;
}
