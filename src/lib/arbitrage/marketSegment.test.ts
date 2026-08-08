import { describe, it, expect } from "vitest";
import { isFullGameMarketTitle, marketSegmentOf } from "./marketSegment";

describe("marketSegment — detects partial-game markets", () => {
  it("flags the reported MLB first-5-innings total as a segment", () => {
    // This is the exact market that was falsely matched against a Kalshi full-game total.
    expect(marketSegmentOf("San Diego Padres vs. Arizona Diamondbacks: 1st 5 Innings O/U 2.5")).toBe("segment");
    expect(isFullGameMarketTitle("San Diego Padres vs. Arizona Diamondbacks: 1st 5 Innings O/U 2.5")).toBe(false);
  });

  it("flags F5 shorthand and 'first 5/3 innings' phrasings", () => {
    expect(marketSegmentOf("Yankees vs Red Sox F5 O/U 4.5")).toBe("segment");
    expect(marketSegmentOf("Cubs vs Reds First 5 Innings O/U 5")).toBe("segment");
    expect(marketSegmentOf("Mets vs Braves first 3 innings total")).toBe("segment");
  });

  it("flags single innings, halves, periods, and quarters", () => {
    expect(marketSegmentOf("Runs in the 1st inning")).toBe("segment");
    expect(marketSegmentOf("3rd inning over 0.5")).toBe("segment");
    expect(marketSegmentOf("Arsenal vs Chelsea 1st Half O/U 1.5")).toBe("segment");
    expect(marketSegmentOf("Lakers vs Celtics 2H spread")).toBe("segment");
    expect(marketSegmentOf("Bruins vs Rangers 2nd Period total")).toBe("segment");
    expect(marketSegmentOf("Chiefs vs Bills 1st Quarter O/U")).toBe("segment");
    expect(marketSegmentOf("Warriors vs Suns Q3 total")).toBe("segment");
  });

  it("does NOT flag full-game markets (no false exclusions)", () => {
    expect(isFullGameMarketTitle("Over 8.5 runs scored")).toBe(true); // Kalshi total
    expect(isFullGameMarketTitle("Los Angeles Dodgers wins by over 1.5 runs")).toBe(true); // Kalshi spread
    expect(isFullGameMarketTitle("San Diego Padres vs. Arizona Diamondbacks O/U 8.5")).toBe(true); // Poly full-game total
    expect(isFullGameMarketTitle("New York Yankees vs. Boston Red Sox")).toBe(true); // moneyline
    expect(isFullGameMarketTitle("Total runs (9 innings) over 7.5")).toBe(true); // "9 innings" = full game
    expect(isFullGameMarketTitle("Full Game O/U 8.5")).toBe(true);
    expect(isFullGameMarketTitle(undefined)).toBe(true);
    expect(isFullGameMarketTitle("")).toBe(true);
  });
});
