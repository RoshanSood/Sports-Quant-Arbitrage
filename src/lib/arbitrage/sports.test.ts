import { describe, expect, it } from "vitest";
import { SPORTS } from "./sports";

describe("sports config - tennis coverage", () => {
  it("wires both ATP and WTA tennis moneyline across eligible venues", () => {
    const tennis = SPORTS.filter((cfg) => cfg.sport === "tennis");

    expect(tennis.map((cfg) => cfg.league).sort()).toEqual(["atp", "wta"]);
    for (const cfg of tennis) {
      expect(cfg.markets).toEqual({ moneyline: true });
      expect(cfg.polyTag).toBe("tennis");
      expect(cfg.sxDynamic?.sportId).toBe(6);
      expect(cfg.cloudbet?.sport).toBe("tennis");
      expect(cfg.cloudbet?.moneyline).toBe("tennis.winner");
      expect(cfg.kalshi).toBeUndefined();
      expect(cfg.predictfun).toBeUndefined();
    }
  });
});

describe("sports config - Brazil soccer totals", () => {
  it("wires Brazil Serie A soccer totals across Polymarket and dynamic SX leagues", () => {
    const cfg = SPORTS.find((s) => s.sport === "soccer" && s.league === "bra1");

    expect(cfg).toBeDefined();
    expect(cfg?.markets).toEqual({ totals: true, moneyline: true });
    expect(cfg?.polyTag).toBe("soccer");
    expect(cfg?.sxDynamic?.sportId).toBe(5);
    expect(cfg?.sxDynamic?.totals).toBe(true);
    expect(cfg?.kalshi).toBeUndefined();
  });
});
