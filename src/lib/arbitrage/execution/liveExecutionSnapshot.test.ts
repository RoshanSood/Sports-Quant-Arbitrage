import { describe, expect, it } from "vitest";
import type { ArbLeg } from "@/types/arbitrage";
import { captureLiveExecutionSnapshot, isPolymarketKalshiNativePair } from "./liveExecutionSnapshot";

function leg(venueId: string, marketId: string): ArbLeg {
  return {
    venueId,
    marketId,
    nativeMarketId: venueId === "kalshi" ? "K" : undefined,
    nativeSide: venueId === "polymarket" ? "TOKEN" : "yes",
    outcome: "home",
    priceCents: 50,
    decimalOdds: 2,
    impliedProbability: 0.5,
    size: 6,
    feeCents: 0,
    label: "Home",
  };
}

describe("immutable native execution snapshots", () => {
  const legs = [leg("polymarket", "p"), leg("kalshi", "k")];

  it("captures a complete fresh buffered Polymarket/Kalshi basket", () => {
    const source = new Map([
      ["p", { levels: [{ priceCents: 45, contracts: 20 }], updatedAt: 9_900 }],
      ["k", { levels: [{ priceCents: 50, contracts: 25 }], updatedAt: 9_800 }],
    ]);
    const result = captureLiveExecutionSnapshot(legs, (candidate) => source.get(candidate.marketId) ?? null, 10_000, 500, 3);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot?.oldestAgeMs).toBe(200);
    expect(result.snapshot?.legs[0].levels[0]).toEqual({ priceCents: 45, contracts: 20 });
    source.get("p")!.levels[0].priceCents = 99;
    expect(result.snapshot?.legs[0].levels[0].priceCents).toBe(45);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it("identifies only an exact Polymarket/Kalshi pair for the mandatory fast path", () => {
    expect(isPolymarketKalshiNativePair(legs)).toBe(true);
    expect(isPolymarketKalshiNativePair([leg("polymarket", "p"), leg("polymarket", "p2")])).toBe(false);
    expect(isPolymarketKalshiNativePair([leg("kalshi", "k"), leg("sxbet", "s")])).toBe(false);
  });

  it("falls back when a ladder is stale, missing, unsupported, or lacks buffered depth", () => {
    const fresh = (candidate: ArbLeg) => ({ levels: [{ priceCents: 50, contracts: 20 }], updatedAt: candidate.marketId === "p" ? 9_000 : 9_900 });
    expect(captureLiveExecutionSnapshot(legs, fresh, 10_000, 500, 3).reason).toContain("old");
    expect(captureLiveExecutionSnapshot(legs, () => null, 10_000, 500, 3).reason).toContain("missing");
    expect(captureLiveExecutionSnapshot(legs, () => ({ levels: [{ priceCents: 50, contracts: 10 }], updatedAt: 9_900 }), 10_000, 500, 3).reason).toContain("buffered");
    expect(captureLiveExecutionSnapshot([leg("kalshi", "k"), leg("sxbet", "s")], () => null, 10_000, 500, 3).reason).toContain("supports only");
  });
});
