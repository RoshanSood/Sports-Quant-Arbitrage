import { describe, expect, it } from "vitest";
import { formatMatchup } from "./arbFormat";

describe("formatMatchup", () => {
  it("renders canonical team separators as a readable versus matchup", () => {
    expect(formatMatchup("seattle mariners|tampa bay rays")).toBe("Seattle Mariners vs Tampa Bay Rays");
  });

  it("preserves an agent prefix", () => {
    expect(formatMatchup("[AG:kalshi-mlb] seattle mariners|tampa bay rays")).toBe(
      "[AG:kalshi-mlb] Seattle Mariners vs Tampa Bay Rays"
    );
  });

  it("leaves already formatted matchup text unchanged", () => {
    expect(formatMatchup("Seattle Mariners vs Tampa Bay Rays")).toBe("Seattle Mariners vs Tampa Bay Rays");
  });
});
