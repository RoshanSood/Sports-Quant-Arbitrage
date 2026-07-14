// Pure fair-probability + discrepancy math for the prop scanner (manual §17–§20).
// No I/O — unit-testable. Probabilities are fractions (0–1); American odds are
// standard (+150 / -120). The bright "Odds to Hit" number is a CONSENSUS fair
// probability and must never be a single book's juiced implied probability (§17).

import type { Side } from "@/types/props";

// ── American ⇄ probability (manual §17) ──────────────────────────────────────

export function americanToProbability(a: number): number {
  return a < 0 ? Math.abs(a) / (Math.abs(a) + 100) : 100 / (a + 100);
}

export function americanToDecimal(a: number): number {
  return a < 0 ? 1 + 100 / Math.abs(a) : 1 + a / 100;
}

// Convert a fair probability back to American odds. Rounds to the nearest integer.
export function probabilityToAmerican(p: number): number {
  const clamped = clamp01(p);
  if (clamped <= 0) return 100000;
  if (clamped >= 1) return -100000;
  const a = clamped >= 0.5 ? (-100 * clamped) / (1 - clamped) : (100 * (1 - clamped)) / clamped;
  return Math.round(a);
}

// Two-way de-vig: remove the book's margin from a same-line over/under pair (§17).
export function devigTwoWay(overRaw: number, underRaw: number): { over: number; under: number } {
  const total = overRaw + underRaw;
  if (total <= 0) return { over: 0, under: 0 };
  return { over: overRaw / total, under: underRaw / total };
}

// De-vig a same-line over/under American pair → fair probability for a side.
export function devigAmericanPair(overAmerican: number, underAmerican: number, side: Side): number {
  const { over, under } = devigTwoWay(
    americanToProbability(overAmerican),
    americanToProbability(underAmerican)
  );
  return side === "OVER" ? over : under;
}

// ── Logit-space interpolation across the alternate-line ladder (manual §20) ──

export function logit(p: number): number {
  const c = clampProb(p);
  return Math.log(c / (1 - c));
}

export function invLogit(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export type LadderPoint = { line: number; probability: number };

// Estimate the hit probability at `anchorLine` from a per-book ladder of de-vigged
// probabilities for the selected side. Enforces monotonicity, interpolates in logit
// space between the bracketing lines, and returns a confidence multiplier reflecting
// how much extrapolation was required (manual §20). Returns null if no usable points.
export function interpolateAtLine(
  points: LadderPoint[],
  anchorLine: number,
  side: Side,
  naturalStep: number
): { probability: number; confidenceMultiplier: number } | null {
  if (!points.length) return null;

  // For OVER, probability decreases as the line rises; for UNDER it increases.
  // Sort by line and enforce monotonicity so a single bad quote can't invert the curve.
  const sorted = [...points].sort((a, b) => a.line - b.line);
  const mono = enforceMonotonic(sorted, side);

  // Exact line present?
  const exact = mono.find((p) => Math.abs(p.line - anchorLine) < 1e-9);
  if (exact) return { probability: clampProb(exact.probability), confidenceMultiplier: 1.0 };

  // Find the bracketing pair.
  let lower: LadderPoint | null = null;
  let upper: LadderPoint | null = null;
  for (const p of mono) {
    if (p.line < anchorLine) lower = p;
    if (p.line > anchorLine) {
      upper = p;
      break;
    }
  }

  if (lower && upper) {
    const t = (anchorLine - lower.line) / (upper.line - lower.line);
    const anchorLogit = logit(lower.probability) + t * (logit(upper.probability) - logit(lower.probability));
    return { probability: clampProb(invLogit(anchorLogit)), confidenceMultiplier: 0.85 };
  }

  // Outside the ladder: use the nearest point only, with a large confidence penalty.
  const nearest = mono.reduce((best, p) =>
    Math.abs(p.line - anchorLine) < Math.abs(best.line - anchorLine) ? p : best
  );
  const dist = Math.abs(nearest.line - anchorLine);
  const mult = dist <= naturalStep ? 0.65 : 0.35;
  return { probability: clampProb(nearest.probability), confidenceMultiplier: mult };
}

function enforceMonotonic(sortedByLine: LadderPoint[], side: Side): LadderPoint[] {
  // OVER: non-increasing in line. UNDER: non-decreasing in line.
  const out = sortedByLine.map((p) => ({ ...p }));
  for (let i = 1; i < out.length; i++) {
    if (side === "OVER" && out[i].probability > out[i - 1].probability) {
      out[i].probability = out[i - 1].probability;
    } else if (side === "UNDER" && out[i].probability < out[i - 1].probability) {
      out[i].probability = out[i - 1].probability;
    }
  }
  return out;
}

// ── Weighted median consensus (manual §19) ───────────────────────────────────

export type Weighted = { value: number; weight: number };

// Weighted median: one stale/erroneous quote shouldn't pull the consensus.
export function weightedMedian(items: Weighted[]): number | null {
  const valid = items.filter((i) => i.weight > 0 && Number.isFinite(i.value));
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  let acc = 0;
  for (const it of sorted) {
    acc += it.weight;
    if (acc >= total / 2) return it.value;
  }
  return sorted[sorted.length - 1].value;
}

// Median absolute deviation around the (weighted) median — the dispersion metric.
export function medianAbsoluteDeviation(values: number[], center: number): number {
  if (!values.length) return 0;
  const devs = values.map((v) => Math.abs(v - center)).sort((a, b) => a - b);
  const mid = Math.floor(devs.length / 2);
  return devs.length % 2 ? devs[mid] : (devs[mid - 1] + devs[mid]) / 2;
}

// ── Directional line edge (manual §18) ───────────────────────────────────────

// Positive → the anchor line is EASIER for the selected side.
export function directionalLineEdge(side: Side, anchorLine: number, consensusLine: number): number {
  return side === "OVER" ? consensusLine - anchorLine : anchorLine - consensusLine;
}

// ── Ranking (manual §19) ─────────────────────────────────────────────────────

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// rawScore blends line, probability, and price z-scores; rankScore folds in
// confidence so weak evidence can't top the board (manual §19).
export function rankScore(lineZ: number, probabilityZ: number, priceZ: number, confidence: number): number {
  const raw = 0.5 * lineZ + 0.4 * probabilityZ + 0.1 * priceZ;
  return Math.round(100 * sigmoid(raw) * (0.5 + 0.5 * clamp01(confidence)));
}

// Confidence blend (manual §19). All inputs are 0–1.
export function confidenceScore(c: {
  exactLineCoverage: number;
  bookCountScore: number;
  freshnessScore: number;
  identityScore: number;
  dispersionScore: number;
}): number {
  return clamp01(
    0.3 * c.exactLineCoverage +
      0.25 * c.bookCountScore +
      0.2 * c.freshnessScore +
      0.15 * c.identityScore +
      0.1 * c.dispersionScore
  );
}

function clampProb(p: number): number {
  return Math.max(1e-6, Math.min(1 - 1e-6, p));
}
