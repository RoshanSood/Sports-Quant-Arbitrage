// Consensus + discrepancy engine (manual §17–§21). For one canonical prop group,
// one anchor line, and one side, it de-vigs each sportsbook's same-line over/under
// pair, interpolates every book's ladder to the anchor line in logit space, takes a
// weighted median, and derives the directional line edge, confidence, rank score,
// reason, and flags. DFS operators supply LINES (for the line gap) but not fair
// PROBABILITY — the "Odds to Hit" number is a sportsbook/sharp consensus (§17).

import type {
  BookSummary,
  CalculationTrace,
  CanonicalStat,
  DiscrepancyReason,
  DiscrepancySummary,
  ReasonCode,
  Side,
} from "@/types/props";
import { getBook } from "./books";
import type { PropQuote } from "./normalize";
import {
  clamp01,
  confidenceScore,
  devigTwoWay,
  directionalLineEdge,
  interpolateAtLine,
  medianAbsoluteDeviation,
  probabilityToAmerican,
  rankScore,
  weightedMedian,
  type LadderPoint,
  type Weighted,
} from "./oddsMath";

export const SOFT_STALE_MS = 60_000;
export const HARD_STALE_MS = 300_000;
const MIN_BOOKS_FOR_PROB = 2;
const OUTLIER_K = 3;
const DEFAULT_BREAK_EVEN = 0.5;

const SOURCE_QUALITY: Record<BookSummary["category"], number> = {
  sharp: 1.0,
  sportsbook: 0.85,
  dfs: 0.5,
};

export type ConsensusInput = {
  quotes: PropQuote[]; // all quotes for the group (both sides, all books, all lines)
  side: Side;
  anchorLine: number;
  anchorBookId: string;
  stat: CanonicalStat;
  now: number;
  minLineGap: number;
};

export type ConsensusResult = {
  fairHitProbability: number | null;
  fairAmericanOdds: number | null;
  confidence: number;
  discrepancy: DiscrepancySummary;
  flags: ReasonCode[];
  outlierQuoteIds: Set<string>;
  staleQuoteIds: Set<string>;
  trace: CalculationTrace;
};

type BookLadder = {
  bookId: string;
  category: BookSummary["category"];
  weight: number; // book-level source quality × best freshness
  points: LadderPoint[]; // de-vigged prob for `side` at each line with both O/U
  mainLine: number | null; // representative market line for `side`
  freshest: number; // freshest observedAt ms
  anyStale: boolean;
};

function freshnessWeight(ageMs: number): number {
  if (ageMs <= SOFT_STALE_MS) return 1;
  if (ageMs >= HARD_STALE_MS) return 0;
  // linear decay 1 → 0.2 between soft and hard
  const t = (ageMs - SOFT_STALE_MS) / (HARD_STALE_MS - SOFT_STALE_MS);
  return 1 - 0.8 * t;
}

// Build, for each market book (sharp + sportsbook, excluding DFS + anchor), a ladder
// of de-vigged probabilities for `side` and a representative main line.
function buildLadders(input: ConsensusInput): { ladders: BookLadder[]; staleIds: Set<string> } {
  const staleIds = new Set<string>();
  const byBook = new Map<string, PropQuote[]>();
  for (const q of input.quotes) {
    if (q.bookId === input.anchorBookId) continue;
    const meta = getBook(q.bookId);
    if (!meta || meta.category === "dfs") continue; // DFS lines handled separately for the line gap
    (byBook.get(q.bookId) ?? byBook.set(q.bookId, []).get(q.bookId)!).push(q);
  }

  const ladders: BookLadder[] = [];
  for (const [bookId, qs] of byBook) {
    const meta = getBook(bookId)!;
    // Index prices by line+side.
    const overAt = new Map<number, PropQuote>();
    const underAt = new Map<number, PropQuote>();
    let freshest = 0;
    let anyStale = false;
    for (const q of qs) {
      const ageMs = input.now - new Date(q.observedAt).getTime();
      if (ageMs >= HARD_STALE_MS) {
        staleIds.add(q.quoteId);
        continue; // hard-stale: exclude entirely
      }
      if (ageMs > SOFT_STALE_MS) {
        staleIds.add(q.quoteId);
        anyStale = true;
      }
      freshest = Math.max(freshest, new Date(q.observedAt).getTime());
      if (!q.available || q.americanOdds == null) continue;
      const m = q.side === "OVER" ? overAt : underAt;
      m.set(q.line, q);
    }

    // De-vig each line where both sides are present → prob for the requested side.
    const points: LadderPoint[] = [];
    const lines = new Set<number>([...overAt.keys()].filter((l) => underAt.has(l)));
    for (const line of lines) {
      const over = overAt.get(line)!;
      const under = underAt.get(line)!;
      const { over: pOver, under: pUnder } = devigTwoWay(
        americanToProb(over.americanOdds!),
        americanToProb(under.americanOdds!)
      );
      points.push({ line, probability: input.side === "OVER" ? pOver : pUnder });
    }

    // Representative market line for `side`: the line whose de-vigged prob is nearest 0.5.
    const sideLines = input.side === "OVER" ? [...overAt.keys()] : [...underAt.keys()];
    const mainLine =
      points.length > 0
        ? points.reduce((best, p) => (Math.abs(p.probability - 0.5) < Math.abs(best.probability - 0.5) ? p : best)).line
        : sideLines.length
          ? sideLines.sort((a, b) => a - b)[Math.floor(sideLines.length / 2)]
          : null;

    const ageMs = input.now - freshest;
    ladders.push({
      bookId,
      category: meta.category,
      weight: SOURCE_QUALITY[meta.category] * freshnessWeight(freshest ? ageMs : HARD_STALE_MS),
      points,
      mainLine,
      freshest,
      anyStale,
    });
  }
  return { ladders, staleIds };
}

function americanToProb(a: number): number {
  return a < 0 ? Math.abs(a) / (Math.abs(a) + 100) : 100 / (a + 100);
}

export function computeConsensus(input: ConsensusInput): ConsensusResult {
  const { ladders, staleIds } = buildLadders(input);
  const step = input.stat.naturalStep || 0.5;
  const scale = input.stat.dispersionScale || 1;

  // ── Consensus market line (from books with a usable main line) ──────────────
  const lineItems: Weighted[] = ladders
    .filter((l) => l.mainLine != null && l.weight > 0)
    .map((l) => ({ value: l.mainLine as number, weight: l.weight }));
  const consensusLine = weightedMedian(lineItems);

  // ── Fair probability at the anchor line (per-book ladder → weighted median) ──
  const probEstimates: { bookId: string; prob: number; weight: number }[] = [];
  for (const l of ladders) {
    if (!l.points.length || l.weight <= 0) continue;
    const est = interpolateAtLine(l.points, input.anchorLine, input.side, step);
    if (!est) continue;
    probEstimates.push({ bookId: l.bookId, prob: est.probability, weight: l.weight * est.confidenceMultiplier });
  }

  // ── Outlier exclusion on the probability estimates (robust MAD gate) ─────────
  const outlierQuoteIds = new Set<string>();
  let usableProb = probEstimates;
  if (probEstimates.length >= MIN_BOOKS_FOR_PROB) {
    const center = weightedMedian(probEstimates.map((e) => ({ value: e.prob, weight: e.weight })))!;
    const mad = medianAbsoluteDeviation(
      probEstimates.map((e) => e.prob),
      center
    );
    if (mad > 0) {
      const kept: typeof probEstimates = [];
      for (const e of probEstimates) {
        if (Math.abs(e.prob - center) > OUTLIER_K * mad) {
          // Mark the book's contributing quotes as outliers.
          for (const q of input.quotes) if (q.bookId === e.bookId) outlierQuoteIds.add(q.quoteId);
        } else kept.push(e);
      }
      if (kept.length >= 1) usableProb = kept;
    }
  }

  const fairHitProbability =
    usableProb.length >= MIN_BOOKS_FOR_PROB
      ? weightedMedian(usableProb.map((e) => ({ value: e.prob, weight: e.weight })))
      : null;

  const dispersion =
    usableProb.length > 0
      ? medianAbsoluteDeviation(
          usableProb.map((e) => e.prob),
          fairHitProbability ?? 0.5
        )
      : null;

  // ── Edges + z-scores ────────────────────────────────────────────────────────
  const lineEdge = consensusLine != null ? directionalLineEdge(input.side, input.anchorLine, consensusLine) : null;
  const lineZ = lineEdge != null ? lineEdge / scale : 0;
  const probEdge = fairHitProbability != null ? Number((fairHitProbability - DEFAULT_BREAK_EVEN).toFixed(4)) : null;
  const probZ = probEdge != null && dispersion ? probEdge / Math.max(dispersion, 0.02) : (probEdge ?? 0) * 5;

  // ── Confidence (manual §19) ─────────────────────────────────────────────────
  const marketBookCount = ladders.filter((l) => l.weight > 0).length;
  const exactLineCoverage = clamp01(
    ladders.filter((l) => l.points.some((p) => Math.abs(p.line - input.anchorLine) < 1e-9)).length /
      Math.max(marketBookCount, 1)
  );
  const confidence = confidenceScore({
    exactLineCoverage,
    bookCountScore: clamp01(marketBookCount / 6),
    freshnessScore: clamp01(ladders.reduce((s, l) => s + l.weight, 0) / Math.max(marketBookCount, 1)),
    identityScore: input.quotes[0]?.player.team ? 1 : 0.6,
    dispersionScore: dispersion != null ? clamp01(1 - dispersion * 5) : 0.5,
  });

  const score = rankScore(lineZ, probZ, 0, confidence);

  // ── Reason + flags ──────────────────────────────────────────────────────────
  const hasLineGap = lineEdge != null && lineEdge >= step;
  const hasPriceGap = fairHitProbability != null && probEdge != null && probEdge > 0.005;
  let reason: DiscrepancyReason;
  if (marketBookCount < MIN_BOOKS_FOR_PROB || fairHitProbability == null) reason = hasLineGap ? "LINE_GAP" : "INSUFFICIENT_DATA";
  else if (hasLineGap && hasPriceGap) reason = "BOTH";
  else if (hasLineGap) reason = "LINE_GAP";
  else if (hasPriceGap) reason = "PRICE_GAP";
  else reason = "INSUFFICIENT_DATA";

  const flags: ReasonCode[] = [];
  if (hasLineGap) flags.push("FAVORABLE_LINE_GAP");
  if (fairHitProbability != null && fairHitProbability >= 0.52 && confidence >= 0.65) flags.push("HIGH_HIT_PROBABILITY");
  if (!hasLineGap && hasPriceGap) flags.push("SAME_LINE_PRICE_GAP");
  if (outlierQuoteIds.size) flags.push("MARKET_OUTLIER");
  if (staleIds.size) flags.push("STALE_QUOTE");
  if (marketBookCount < MIN_BOOKS_FOR_PROB || fairHitProbability == null) flags.push("INSUFFICIENT_MARKET_DATA");

  const includedQuoteIds = input.quotes
    .filter((q) => !outlierQuoteIds.has(q.quoteId) && !staleIds.has(q.quoteId) && q.bookId !== input.anchorBookId)
    .map((q) => q.quoteId);
  const rejectedQuoteIds = [
    ...[...outlierQuoteIds].map((id) => ({ quoteId: id, reason: "MARKET_OUTLIER" as const })),
    ...[...staleIds].map((id) => ({ quoteId: id, reason: "STALE_QUOTE" as const })),
  ];

  const trace: CalculationTrace = {
    methodVersion: "consensus-1",
    includedQuoteIds,
    rejectedQuoteIds,
    thresholds: { minLineGap: input.minLineGap, softStaleSec: SOFT_STALE_MS / 1000, hardStaleSec: HARD_STALE_MS / 1000, outlierK: OUTLIER_K },
    confidenceComponents: { exactLineCoverage, marketBookCount, dispersion: dispersion ?? 0 },
    ladderPoints: ladders.flatMap((l) => l.points.map((p) => ({ bookId: l.bookId, line: p.line, probability: Number(p.probability.toFixed(4)) }))),
  };

  const discrepancy: DiscrepancySummary = {
    anchorLine: input.anchorLine,
    consensusLine,
    directionalLineEdge: lineEdge,
    lineZScore: lineEdge != null ? Number(lineZ.toFixed(3)) : null,
    marketHitProbability: fairHitProbability,
    breakEvenProbability: DEFAULT_BREAK_EVEN,
    probabilityEdge: probEdge,
    dispersion: dispersion != null ? Number(dispersion.toFixed(4)) : null,
    score,
    reason,
  };

  return {
    fairHitProbability,
    fairAmericanOdds: fairHitProbability != null ? probabilityToAmerican(fairHitProbability) : null,
    confidence,
    discrepancy,
    flags,
    outlierQuoteIds,
    staleQuoteIds: staleIds,
    trace,
  };
}
