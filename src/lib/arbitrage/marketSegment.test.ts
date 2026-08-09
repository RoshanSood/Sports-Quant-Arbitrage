import { describe, it, expect } from "vitest";
import { classifyMarketSegment, isFullGameMarketTitle } from "./marketSegment";

describe("marketSegment — classifies full game vs F5 vs unsupported segments", () => {
  it("classifies the exact reported F5 titles as f5", () => {
    expect(classifyMarketSegment("San Diego Padres vs. Arizona Diamondbacks: 1st 5 Innings O/U 2.5")).toBe("f5");
    expect(classifyMarketSegment("1st 5 Innings Spread: Atlanta Braves (-1.5)")).toBe("f5");
    expect(classifyMarketSegment("Philadelphia Phillies winning after 5 innings?")).toBe("f5");
    expect(classifyMarketSegment("Toronto Blue Jays vs. Philadelphia Phillies: Tied after 5 innings?")).toBe("f5");
  });

  it("classifies F5 shorthand and 'first five' phrasing", () => {
    expect(classifyMarketSegment("Yankees vs Red Sox F5 O/U 4.5")).toBe("f5");
    expect(classifyMarketSegment("Cubs vs Reds First 5 Innings O/U 5")).toBe("f5");
  });

  it("classifies genuine full-game markets as full_game (no false positives)", () => {
    expect(classifyMarketSegment("Over 8.5 runs scored")).toBe("full_game"); // Kalshi total
    expect(classifyMarketSegment("Los Angeles Dodgers wins by over 1.5 runs")).toBe("full_game"); // Kalshi spread
    expect(classifyMarketSegment("Atlanta Braves vs. Chicago White Sox: O/U 8.5")).toBe("full_game");
    expect(classifyMarketSegment("Spread: Atlanta Braves (-1.5)")).toBe("full_game");
    expect(classifyMarketSegment("New York Yankees vs. Boston Red Sox")).toBe("full_game"); // moneyline
    expect(classifyMarketSegment("Total runs (9 innings) over 7.5")).toBe("full_game");
    expect(classifyMarketSegment(undefined)).toBe("full_game");
    expect(classifyMarketSegment("")).toBe("full_game");
    expect(isFullGameMarketTitle("Over 8.5 runs scored")).toBe(true);
  });

  it("excludes unsupported partial segments (single inning, half, period, quarter, F3/F7)", () => {
    expect(classifyMarketSegment("Runs in the 1st inning")).toBeNull();
    expect(classifyMarketSegment("3rd inning over 0.5")).toBeNull();
    expect(classifyMarketSegment("Arsenal vs Chelsea 1st Half O/U 1.5")).toBeNull();
    expect(classifyMarketSegment("Lakers vs Celtics 2H spread")).toBeNull();
    expect(classifyMarketSegment("Bruins vs Rangers 2nd Period total")).toBeNull();
    expect(classifyMarketSegment("Chiefs vs Bills 1st Quarter O/U")).toBeNull();
    expect(classifyMarketSegment("Warriors vs Suns Q3 total")).toBeNull();
    expect(classifyMarketSegment("First 3 Innings Winner")).toBeNull();
    expect(classifyMarketSegment("First 7 Innings Winner")).toBeNull();
    expect(isFullGameMarketTitle("Runs in the 1st inning")).toBe(false);
  });
});
