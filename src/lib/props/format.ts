// Presentational formatters for the prop scanner UI. No math beyond display
// rounding; the numeric work lives in oddsMath.ts.

import type { CellState, PromoTag, ReasonCode } from "@/types/props";

export function formatAmerican(a: number | null | undefined): string {
  if (a == null || !Number.isFinite(a)) return "";
  return a > 0 ? `+${a}` : `${a}`;
}

// 0.5487 → "54.87%". Two decimals by default (manual §6).
export function formatProbability(p: number | null | undefined, decimals = 2): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(decimals)}%`;
}

// Lines display .0 only when the source shows it or consistency requires it. We
// keep .5 lines as-is and show integers without a trailing .0 (manual §6).
export function formatLine(line: number | null | undefined): string {
  if (line == null || !Number.isFinite(line)) return "";
  return Number.isInteger(line) ? `${line}` : line.toFixed(1);
}

export function formatMultiplier(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return "";
  return `${m}x`;
}

export function formatSignedUnits(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = Math.round(n * 10) / 10;
  return v > 0 ? `+${v}` : `${v}`;
}

// Calendar date of a game in the app's display timezone (PT), as YYYY-MM-DD — the
// key the date filter groups + selects on. Matches formatStartTime's zone so a
// game labeled "Thu" filters under Thursday.
export function gameDateKey(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  } catch {
    return "";
  }
}

// Human label for a game-date key: "Today" / "Tomorrow" / "Thu 7/16".
export function gameDateLabel(key: string, now = new Date()): string {
  const todayKey = gameDateKey(now.toISOString());
  const tomorrowKey = gameDateKey(new Date(now.getTime() + 86_400_000).toISOString());
  if (key === todayKey) return "Today";
  if (key === tomorrowKey) return "Tomorrow";
  const d = new Date(`${key}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
}

export function formatStartTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
      hour12: true,
    });
  } catch {
    return "TBD";
  }
}

export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  FAVORABLE_LINE_GAP: "Favorable line gap",
  HIGH_HIT_PROBABILITY: "High hit probability",
  SAME_LINE_PRICE_GAP: "Same-line price gap",
  MARKET_OUTLIER: "Market outlier",
  STALE_QUOTE: "Stale quote",
  HARD_STALE_QUOTE: "Hard-stale quote",
  PERIOD_MISMATCH: "Period mismatch",
  PLAYER_MATCH_AMBIGUOUS: "Ambiguous player match",
  PROMO_LINE: "Promotional line",
  INSUFFICIENT_MARKET_DATA: "Insufficient market data",
};

export function reasonLabel(code: ReasonCode): string {
  return REASON_LABELS[code] ?? code;
}

export const PROMO_LABELS: Record<PromoTag, string> = {
  demon: "Demon",
  goblin: "Goblin",
  boosted: "Boosted",
  discounted: "Discounted",
  protected: "Protected",
};

export function promoLabel(tag: PromoTag): string {
  return PROMO_LABELS[tag] ?? tag;
}

// Cell tint tokens (manual §8, §10 state palette). Colors are scoped to the module.
export const CELL_STATE_STYLE: Record<CellState, { border: string; tint: string }> = {
  best: { border: "#22c55e", tint: "rgba(34,197,94,0.10)" },
  favorable: { border: "#4ade80", tint: "rgba(74,222,128,0.08)" },
  stale: { border: "#f59e0b", tint: "rgba(245,158,11,0.08)" },
  suspended: { border: "#334155", tint: "rgba(51,65,85,0.20)" },
  outlier: { border: "#ef4444", tint: "rgba(239,68,68,0.10)" },
  low_confidence: { border: "#7c3aed", tint: "rgba(124,58,237,0.08)" },
};
