import { describe, expect, it } from "vitest";
import type { ArbLeg } from "@/types/arbitrage";
import {
  fragileVenueFirstOrder,
  commonExecutableRequests,
  checkLiveFillability,
  liveVenueMinimumStakeBlockers,
  shouldSequenceFragileVenuePair,
} from "./executor";
import type { OrderRequest } from "./types";

function leg(venueId: string, size: number, priceCents: number): ArbLeg {
  return {
    venueId,
    marketId: `${venueId}:m`,
    outcome: "home",
    priceCents,
    decimalOdds: 100 / priceCents,
    impliedProbability: priceCents / 100,
    size,
    feeCents: 0,
    label: "Home",
  };
}

describe("executor live venue minimum stake guard", () => {
  it("blocks SX.bet fills below its $1.01 taker minimum", () => {
    expect(liveVenueMinimumStakeBlockers([leg("sxbet", 6, 12)])).toEqual([
      "SX.bet Home stake $0.72 is below minimum $1.01",
    ]);
  });

  it("blocks Polymarket fills below the shared $1.01 minimum", () => {
    expect(liveVenueMinimumStakeBlockers([leg("polymarket", 1, 90)])).toEqual([
      "Polymarket Home stake $0.90 is below minimum $1.01",
    ]);
  });

  it("allows fills only when every venue clears the shared minimum", () => {
    expect(
      liveVenueMinimumStakeBlockers([leg("sxbet", 9, 12), leg("polymarket", 2, 60), leg("kalshi", 21, 5)])
    ).toEqual([]);
  });

  it("enforces Predict.fun's two-contract rule", () => {
    expect(liveVenueMinimumStakeBlockers([leg("predictfun", 1.5, 80)])).toEqual([
      "Predict.fun Home size 1.50 is below minimum 2.00 contracts",
    ]);
  });
});

describe("common executable contract sizing", () => {
  const req = (venueId: string): OrderRequest => ({
    venueId,
    marketId: `${venueId}:m`,
    outcome: "home",
    sizeContracts: 3,
    limitPriceCents: venueId === "polymarket" ? 63 : 24,
  });

  it("uses exactly the same fillable contract count on both venues", () => {
    const result = commonExecutableRequests([req("kalshi"), req("polymarket")], [
      { ok: true, priceCents: 24, averagePriceCents: 24, availableContracts: 3 },
      { ok: false, priceCents: 63, averagePriceCents: 62.5, availableContracts: 2.876 },
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.commonContracts).toBe(2.87);
    expect(result.requests.map((r) => r.sizeContracts)).toEqual([2.87, 2.87]);
  });

  it("blocks the entire basket when any venue has zero executable depth", () => {
    const result = commonExecutableRequests([req("kalshi"), req("polymarket")], [
      { ok: true, priceCents: 24, averagePriceCents: 24, availableContracts: 3 },
      { ok: false, priceCents: 63, averagePriceCents: 63, availableContracts: 0, reason: "no Polymarket asks" },
    ]);
    expect(result.commonContracts).toBe(0);
    expect(result.blockers).toEqual(["no Polymarket asks"]);
  });

  it("requires buffered depth while preserving the requested three-contract basket", () => {
    const result = commonExecutableRequests([req("kalshi"), req("polymarket")], [
      { ok: true, priceCents: 24, averagePriceCents: 24, availableContracts: 12 },
      { ok: true, priceCents: 63, averagePriceCents: 62.5, availableContracts: 9 },
    ], 3);
    expect(result.commonContracts).toBe(3);
    expect(result.requests.map((r) => r.sizeContracts)).toEqual([3, 3]);
  });
});

describe("executor SX.bet execution ordering", () => {
  const req = (venueId: string): OrderRequest => ({
    venueId,
    marketId: `${venueId}:m`,
    nativeMarketId: `${venueId}:native`,
    nativeSide: venueId === "sxbet" ? "one" : "yes",
    outcome: "home",
    sizeContracts: 5,
    limitPriceCents: 50,
  });

  it("places SX.bet first when the route includes SX.bet + Polymarket", () => {
    expect(fragileVenueFirstOrder([req("polymarket"), req("sxbet")])).toEqual([1, 0]);
  });

  it("does NOT sequence Polymarket + Kalshi (no SX.bet) — fires concurrently", () => {
    // Sequencing these was net-negative once Polymarket started filling reliably: it
    // added a confirmation round-trip before Kalshi's turn, and on 2026-08-08 that delay
    // alone caused 9 of 15 live trades to go naked (Kalshi's IOC came back genuinely
    // unfilled — a real order, no error — because the market had moved by the time it fired).
    const requests = [req("kalshi"), req("polymarket")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(false);
    expect(fragileVenueFirstOrder(requests)).toEqual([0, 1]); // order is irrelevant when unsequenced
  });

  it("does NOT sequence Polymarket + predict.fun (no SX.bet) — fires concurrently", () => {
    const requests = [req("predictfun"), req("polymarket")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(false);
  });

  it("does NOT sequence Kalshi + predict.fun (no SX.bet) — fires concurrently", () => {
    const requests = [req("kalshi"), req("predictfun")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(false);
  });

  it("places SX.bet first for SX.bet/Kalshi routes (fragile on-chain leg leads)", () => {
    expect(fragileVenueFirstOrder([req("sxbet"), req("kalshi")])).toEqual([0, 1]);
    expect(fragileVenueFirstOrder([req("kalshi"), req("sxbet")])).toEqual([1, 0]);
  });
});

describe("checkLiveFillability — live-book price + depth pre-fire gate", () => {
  const req = (venueId: string, limitPriceCents: number, sizeContracts = 5): OrderRequest => ({
    venueId,
    marketId: `${venueId}:m`,
    nativeMarketId: `${venueId}:native`,
    nativeSide: "yes",
    outcome: "home",
    sizeContracts,
    limitPriceCents,
  });

  const noDepth = () => null; // most price-only tests don't care about depth

  it("bumps a live venue's limit up to match a live ask that moved within the cushion", () => {
    const { requests, adjustments, blockers } = checkLiveFillability([req("polymarket", 50)], {
      askCents: () => 51,
      depthAtOrBetter: noDepth,
    });
    expect(blockers).toEqual([]);
    expect(adjustments).toEqual([{ venueId: "polymarket", fromCents: 50, toCents: 51 }]);
    expect(requests[0].limitPriceCents).toBe(51);
  });

  it("blocks the whole trade when the live ask moved beyond the cushion, rather than chasing it", () => {
    const { requests, blockers } = checkLiveFillability([req("polymarket", 50)], {
      askCents: () => 60,
      depthAtOrBetter: noDepth,
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/beyond the 2c cushion/);
    expect(requests[0].limitPriceCents).toBe(50); // unblocked callers still see the original request shape
  });

  it("passes through unchanged when there's no live quote, or the ask moved in our favor", () => {
    expect(checkLiveFillability([req("polymarket", 50)], { askCents: () => null, depthAtOrBetter: noDepth }).blockers).toEqual([]);
    expect(checkLiveFillability([req("polymarket", 50)], { askCents: () => 49, depthAtOrBetter: noDepth }).adjustments).toEqual([]);
  });

  it("also applies to Kalshi legs, not just Polymarket", () => {
    const { adjustments } = checkLiveFillability([req("kalshi", 50)], { askCents: () => 51, depthAtOrBetter: noDepth });
    expect(adjustments).toEqual([{ venueId: "kalshi", fromCents: 50, toCents: 51 }]);
  });

  it("never touches SX.bet/predict.fun legs (no live book for them)", () => {
    const { requests, blockers } = checkLiveFillability([req("sxbet", 50)], { askCents: () => 90, depthAtOrBetter: noDepth });
    expect(blockers).toEqual([]);
    expect(requests[0].limitPriceCents).toBe(50);
  });

  it("blocks when live depth at the limit is short of the required size", () => {
    const { blockers } = checkLiveFillability([req("kalshi", 50, 10)], { askCents: () => null, depthAtOrBetter: () => 4 });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/short of the 10 required/);
  });

  it("does NOT block when depth is unknown (null) — supplements the REST check, doesn't replace it", () => {
    const { blockers } = checkLiveFillability([req("kalshi", 50, 10)], { askCents: () => null, depthAtOrBetter: () => null });
    expect(blockers).toEqual([]);
  });

  it("checks depth at the NUDGED price, not the original limit", () => {
    let seenLimit: number | null = null;
    checkLiveFillability([req("polymarket", 50, 3)], {
      askCents: () => 51,
      depthAtOrBetter: (_req, limitPriceCents) => {
        seenLimit = limitPriceCents;
        return 3;
      },
    });
    expect(seenLimit).toBe(51);
  });

  it("aborts the WHOLE trade (all legs) when only one leg is short — no partial firing", () => {
    const requests = [req("kalshi", 50, 10), req("polymarket", 50, 3)];
    const { blockers } = checkLiveFillability(requests, {
      askCents: () => null,
      depthAtOrBetter: (r) => (r.venueId === "kalshi" ? 2 : 100),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/Kalshi/);
  });
});
