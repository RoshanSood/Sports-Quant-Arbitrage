import { describe, it, expect } from "vitest";
import { findLegSegmentMismatch, opportunityMatchKey } from "./executionPipeline";

describe("opportunityMatchKey", () => {
  const base = "baseball:mlb:chicago white sox|cleveland guardians:2026-08-08T00:00:00.000Z";

  it("groups totals, spreads, moneylines and alternate lines under one physical match", () => {
    expect(opportunityMatchKey(`${base}:total:9.5`)).toBe(base);
    expect(opportunityMatchKey(`${base}:total:10.5`)).toBe(base);
    expect(opportunityMatchKey(`${base}:moneyline:0`)).toBe(base);
    expect(opportunityMatchKey(`${base}:spread:1.5`)).toBe(base);
  });

  it("also counts F5 positions against the same physical-match limit", () => {
    expect(opportunityMatchKey(`${base}:f5:total:4.5`)).toBe(base);
  });
});

// Regression for the 2026-08-08 Astros v Padres live trade: Polymarket's F5 (first-5-innings)
// total O/U 2.5 was matched and EXECUTED against Kalshi's full-game total O/U 2.5 — two
// markets that share a line number but settle on completely different scores, so it was not
// a real hedge. Root cause: the opportunity was detected by a process still running pre-
// segment-fix code, so its legs' marketIds never got an "f5" tag. This gate re-derives each
// leg's segment from the CURRENT market rows at execution time — independent of whatever
// (possibly stale) process produced the opportunity — so this exact failure can't recur even
// if some future bug (or another stale-cache window) lets a bad pairing through detection.
describe("findLegSegmentMismatch", () => {
  it("catches the exact reported case: Polymarket F5 total vs Kalshi full-game total", () => {
    const legs = [
      { venueId: "polymarket", marketId: "polymarket:401816451:total:2.5:over" },
      { venueId: "kalshi", marketId: "kalshi:401816451:total:2.5:under" },
    ];
    // Current market rows (correctly tagged) — the Polymarket row IS actually f5, even
    // though the leg's marketId (from the stale-detected opportunity) doesn't say so.
    const markets = [
      { marketId: "polymarket:401816451:total:2.5:over", segment: "f5" as const },
      { marketId: "kalshi:401816451:total:2.5:under", segment: "full_game" as const },
    ];
    const result = findLegSegmentMismatch(legs, markets);
    expect(result.mismatched).toBe(true);
    expect(result.legSegments).toEqual([
      { venueId: "polymarket", marketId: "polymarket:401816451:total:2.5:over", segment: "f5" },
      { venueId: "kalshi", marketId: "kalshi:401816451:total:2.5:under", segment: "full_game" },
    ]);
  });

  it("passes when every leg is full_game", () => {
    const legs = [
      { venueId: "polymarket", marketId: "polymarket:1:total:8.5:over" },
      { venueId: "kalshi", marketId: "kalshi:1:total:8.5:under" },
    ];
    const markets = [
      { marketId: "polymarket:1:total:8.5:over", segment: "full_game" as const },
      { marketId: "kalshi:1:total:8.5:under", segment: "full_game" as const },
    ];
    expect(findLegSegmentMismatch(legs, markets).mismatched).toBe(false);
  });

  it("passes when every leg is genuinely f5 (a real F5-vs-F5 arb)", () => {
    const legs = [
      { venueId: "polymarket", marketId: "polymarket:1:total:f5:2.5:over" },
      { venueId: "kalshi", marketId: "kalshi:1:total:f5:2.5:under" },
    ];
    const markets = [
      { marketId: "polymarket:1:total:f5:2.5:over", segment: "f5" as const },
      { marketId: "kalshi:1:total:f5:2.5:under", segment: "f5" as const },
    ];
    expect(findLegSegmentMismatch(legs, markets).mismatched).toBe(false);
  });

  it("treats a leg missing from the current market rows as full_game (the safe default)", () => {
    const legs = [{ venueId: "kalshi", marketId: "kalshi:1:total:8.5:under" }];
    expect(findLegSegmentMismatch(legs, []).mismatched).toBe(false);
  });
});
