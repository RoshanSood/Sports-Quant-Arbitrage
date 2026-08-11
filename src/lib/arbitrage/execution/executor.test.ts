import { describe, expect, it } from "vitest";
import type { ArbLeg } from "@/types/arbitrage";
import {
  applyEconomicPriceCushion,
  buildLiveOnlyQuotes,
  fragileVenueFirstOrder,
  commonExecutableRequests,
  checkLiveFillability,
  liveVenueMinimumStakeBlockers,
  optimizeExecutableBasket,
  recoverMissingHedge,
  recoveryPathBlockers,
  shouldSequenceFragileVenuePair,
} from "./executor";
import type { PreparedContext } from "../executionPipeline";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

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

function recoveryContext(maxLoss = 1): PreparedContext {
  return {
    risk: { hedgeRecoveryMaxSlippageCents: 10, hedgeRecoveryMaxLossUsd: maxLoss },
    executedLegs: [leg("polymarket", 6, 65), leg("kalshi", 6, 30)],
  } as PreparedContext;
}

function recoveryAdapter(
  id: string,
  quote: { priceCents: number; availableContracts: number },
  placed: OrderResult
): ExecutionAdapter {
  return {
    id,
    supportsLive: () => true,
    getBalanceUsd: async () => null,
    quoteOrder: async () => ({ ok: true, averagePriceCents: quote.priceCents, ...quote }),
    placeOrder: async () => placed,
  };
}

describe("automatic missing-hedge recovery", () => {
  const requests: OrderRequest[] = [
    { venueId: "polymarket", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 65 },
    { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 30 },
  ];
  const filled: OrderResult = { ok: true, orderId: "poly-fill", filledContracts: 6, avgPriceCents: 65, status: "filled" };
  const missed: OrderResult = { ok: false, orderId: "kalshi-zero", filledContracts: 0, avgPriceCents: 30, status: "unfilled" };

  it("retries only the exact confirmed exposure and closes the basket", async () => {
    let submitted: OrderRequest | null = null;
    const kalshi = recoveryAdapter("kalshi", { priceCents: 31, availableContracts: 20 }, {
      ok: true, orderId: "kalshi-retry", filledContracts: 6, avgPriceCents: 31, status: "filled",
    });
    const originalPlace = kalshi.placeOrder;
    kalshi.placeOrder = async (request) => {
      submitted = request;
      return originalPlace(request);
    };
    const result = await recoverMissingHedge(
      recoveryContext(),
      [recoveryAdapter("polymarket", { priceCents: 65, availableContracts: 20 }, filled), kalshi],
      requests.map((request) => ({ ...request })),
      [filled, missed]
    );
    expect(submitted).toMatchObject({ sizeContracts: 6, limitPriceCents: 40 });
    expect(result.results[1]).toMatchObject({ orderId: "kalshi-retry", filledContracts: 6, status: "filled" });
    expect(result.step).toMatchObject({ key: "hedge_recovery", status: "pass" });
  });

  it("keeps the approved emergency ceiling when the ask moves between quote and placement", async () => {
    let submittedLimit = 0;
    const predict = recoveryAdapter("predictfun", { priceCents: 25, availableContracts: 20 }, missed);
    predict.placeOrder = async (request) => {
      submittedLimit = request.limitPriceCents;
      return request.limitPriceCents >= 27
        ? { ok: true, orderId: "predict-recovery", filledContracts: 6, avgPriceCents: 27, status: "filled" }
        : { ...missed, error: `predict.fun ask moved above limit (27.00c > ${request.limitPriceCents.toFixed(2)}c)` };
    };
    const incidentRequests: OrderRequest[] = [
      { venueId: "predictfun", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 22 },
      { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 32 },
    ];
    const kalshiFill: OrderResult = { ok: true, orderId: "kalshi-fill", filledContracts: 6, avgPriceCents: 24, status: "filled" };
    const ctx = {
      risk: { hedgeRecoveryMaxSlippageCents: 10, hedgeRecoveryMaxLossUsd: 1 },
      executedLegs: [leg("predictfun", 6, 22), leg("kalshi", 6, 32)],
    } as PreparedContext;
    const result = await recoverMissingHedge(
      ctx,
      [predict, recoveryAdapter("kalshi", { priceCents: 32, availableContracts: 20 }, kalshiFill)],
      incidentRequests,
      [missed, kalshiFill]
    );
    expect(submittedLimit).toBe(32);
    expect(result.results[0]).toMatchObject({ filledContracts: 6, avgPriceCents: 27, status: "filled" });
    expect(result.step).toMatchObject({ status: "pass" });
  });

  it("does not call recovery while a venue acknowledgement is still pending", async () => {
    let placements = 0;
    const adapter = recoveryAdapter("kalshi", { priceCents: 31, availableContracts: 20 }, missed);
    adapter.placeOrder = async () => {
      placements += 1;
      return missed;
    };
    const result = await recoverMissingHedge(
      recoveryContext(),
      [recoveryAdapter("polymarket", { priceCents: 65, availableContracts: 20 }, filled), adapter],
      requests.map((request) => ({ ...request })),
      [filled, { ...missed, ok: true, status: "pending" }]
    );
    expect(placements).toBe(0);
    expect(result.step).toBeNull();
  });

  it("retries a pre-submission rejection with no order id, then stops after a fill", async () => {
    let placements = 0;
    const adapter = recoveryAdapter("kalshi", { priceCents: 31, availableContracts: 20 }, missed);
    adapter.placeOrder = async (request) => {
      placements += 1;
      if (placements < 3) return { ...missed, orderId: null, error: "ask moved before submission" };
      return { ok: true, orderId: "third-attempt", filledContracts: 6, avgPriceCents: request.limitPriceCents, status: "filled" };
    };
    const result = await recoverMissingHedge(
      recoveryContext(),
      [recoveryAdapter("polymarket", { priceCents: 65, availableContracts: 20 }, filled), adapter],
      requests.map((request) => ({ ...request })),
      [filled, missed]
    );
    expect(placements).toBe(3);
    expect(result.results[1].orderId).toBe("third-attempt");
  });

  it("never duplicates an accepted recovery order whose confirmation is pending", async () => {
    let placements = 0;
    const adapter = recoveryAdapter("kalshi", { priceCents: 31, availableContracts: 20 }, missed);
    adapter.placeOrder = async (request) => {
      placements += 1;
      return { ok: true, orderId: "accepted", filledContracts: 0, avgPriceCents: request.limitPriceCents, status: "pending" };
    };
    const result = await recoverMissingHedge(
      recoveryContext(),
      [recoveryAdapter("polymarket", { priceCents: 65, availableContracts: 20 }, filled), adapter],
      requests.map((request) => ({ ...request })),
      [filled, missed]
    );
    expect(placements).toBe(1);
    expect(result.results[1]).toMatchObject({ orderId: "accepted", status: "pending" });
    expect(result.step).toMatchObject({ status: "warn" });
  });

  it("recovers only the actual fill difference after a partial hedge", async () => {
    let submittedSize = 0;
    const partial: OrderResult = { ok: true, orderId: "partial", filledContracts: 2, avgPriceCents: 30, status: "partial" };
    const adapter = recoveryAdapter("kalshi", { priceCents: 32, availableContracts: 20 }, partial);
    adapter.placeOrder = async (request) => {
      submittedSize = request.sizeContracts;
      return { ok: true, orderId: "remainder", filledContracts: request.sizeContracts, avgPriceCents: 32, status: "filled" };
    };
    const result = await recoverMissingHedge(
      recoveryContext(),
      [recoveryAdapter("polymarket", { priceCents: 65, availableContracts: 20 }, filled), adapter],
      requests.map((request) => ({ ...request })),
      [filled, partial]
    );
    expect(submittedSize).toBe(4);
    expect(result.results[1].filledContracts).toBe(6);
    expect(result.results[1].avgPriceCents).toBeCloseTo((2 * 30 + 4 * 32) / 6, 6);
  });

  it("records a sub-minimum price-improvement residual without placing an invalid order", async () => {
    let placements = 0;
    const overfill: OrderResult = { ok: true, orderId: "poly", filledContracts: 6.079364, avgPriceCents: 62.18, status: "filled" };
    const exact: OrderResult = { ok: true, orderId: "kalshi", filledContracts: 6, avgPriceCents: 38, status: "filled" };
    const adapter = recoveryAdapter("kalshi", { priceCents: 38, availableContracts: 20 }, exact);
    adapter.placeOrder = async () => {
      placements += 1;
      return exact;
    };
    const ctx = {
      risk: { hedgeRecoveryMaxSlippageCents: 10, hedgeRecoveryMaxLossUsd: 1 },
      executedLegs: [leg("polymarket", 6, 63), leg("kalshi", 6, 35)],
    } as PreparedContext;
    const result = await recoverMissingHedge(ctx, [recoveryAdapter("polymarket", { priceCents: 63, availableContracts: 20 }, overfill), adapter], [
      { venueId: "polymarket", marketId: "p", outcome: "under", sizeContracts: 6, limitPriceCents: 63 },
      { venueId: "kalshi", marketId: "k", outcome: "over", sizeContracts: 6, limitPriceCents: 35 },
    ], [overfill, exact]);
    expect(placements).toBe(0);
    expect(result.results.map((order) => order.filledContracts)).toEqual([6.079364, 6]);
    expect(result.step?.detail).toContain("below Kalshi's minimum recovery order");
  });
});

describe("economics-safe initial price cushions", () => {
  it("uses the full configured cushion when every leg can move and still clear minimum profit", () => {
    const requests: OrderRequest[] = [
      { venueId: "predictfun", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 22 },
      { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 32 },
    ];
    const result = applyEconomicPriceCushion(requests, [leg("predictfun", 6, 22), leg("kalshi", 6, 32)], 0.03, 10);
    expect(result.cushionCents).toBe(10);
    expect(result.requests.map((request) => request.limitPriceCents)).toEqual([32, 42]);
    expect(result.worstCaseProfit).toBeGreaterThanOrEqual(0.03);
  });

  it("reduces a cushion until simultaneous worst-price fills remain profitable", () => {
    const requests: OrderRequest[] = [
      { venueId: "polymarket", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 45 },
      { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 45 },
    ];
    const result = applyEconomicPriceCushion(requests, [leg("polymarket", 6, 45), leg("kalshi", 6, 45)], 0.03, 10);
    expect(result.cushionCents).toBeGreaterThan(0);
    expect(result.cushionCents).toBeLessThan(10);
    expect(result.worstCaseProfit).toBeGreaterThanOrEqual(0.03);
  });

  it("does not let price headroom bypass the maximum live stake", () => {
    const requests: OrderRequest[] = [
      { venueId: "predictfun", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 22 },
      { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 32 },
    ];
    const result = applyEconomicPriceCushion(
      requests,
      [leg("predictfun", 6, 22), leg("kalshi", 6, 32)],
      0.03,
      10,
      3.6
    );
    const worstCost = result.requests.reduce((sum, request) => sum + request.sizeContracts * request.limitPriceCents / 100, 0);
    expect(worstCost).toBeLessThanOrEqual(3.6);
  });

  it("marks the basket unsafe when even zero cushion misses minimum profit", () => {
    const requests: OrderRequest[] = [
      { venueId: "polymarket", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 50 },
      { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 50 },
    ];
    const result = applyEconomicPriceCushion(requests, [leg("polymarket", 6, 50), leg("kalshi", 6, 50)], 0.03, 10);
    expect(result.safe).toBe(false);
    expect(result.cushionCents).toBe(0);
  });
});

describe("pre-submission emergency hedge paths", () => {
  const requests: OrderRequest[] = [
    { venueId: "predictfun", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 22 },
    { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 32 },
  ];

  it("passes only when both venues have enough recovery depth inside the loss ceiling", () => {
    const blockers = recoveryPathBlockers(requests, [
      { ok: true, priceCents: 25, averagePriceCents: 24, availableContracts: 20, levels: [{ priceCents: 25, contracts: 20 }] },
      { ok: true, priceCents: 35, averagePriceCents: 34, availableContracts: 20, levels: [{ priceCents: 35, contracts: 20 }] },
    ], [leg("predictfun", 6, 22), leg("kalshi", 6, 32)], 10, 1);
    expect(blockers).toEqual([]);
  });

  it("blocks before either order when one recovery venue lacks enough contracts", () => {
    const blockers = recoveryPathBlockers(requests, [
      { ok: true, priceCents: 25, averagePriceCents: 25, availableContracts: 2, levels: [{ priceCents: 25, contracts: 2 }] },
      { ok: true, priceCents: 35, averagePriceCents: 35, availableContracts: 20, levels: [{ priceCents: 35, contracts: 20 }] },
    ], [leg("predictfun", 6, 22), leg("kalshi", 6, 32)], 10, 1);
    expect(blockers.some((blocker) => blocker.includes("Predict.fun lacks 6.00 recovery contracts"))).toBe(true);
  });
});

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

  it("passes a large price move to the economic optimizer instead of applying a fixed cushion", () => {
    const { requests, blockers } = checkLiveFillability([req("polymarket", 50)], {
      askCents: () => 60,
      depthAtOrBetter: noDepth,
    });
    expect(blockers).toEqual([]);
    expect(requests[0].limitPriceCents).toBe(60);
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

  it("passes short cached depth to the native-book resizing pass", () => {
    const { blockers } = checkLiveFillability([req("kalshi", 50, 10)], { askCents: () => null, depthAtOrBetter: () => 4 });
    expect(blockers).toEqual([]);
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
    expect(blockers).toEqual([]);
  });
});

describe("executable basket optimizer", () => {
  const req = (venueId: string, price: number, size = 6): OrderRequest => ({
    venueId,
    marketId: `${venueId}:m`,
    nativeMarketId: `${venueId}:native`,
    nativeSide: "yes",
    outcome: venueId === "kalshi" ? "home" : "away",
    sizeContracts: size,
    limitPriceCents: price,
  });

  it("raises the price and downsizes every leg to the same profitable executable count", () => {
    const requests = [req("kalshi", 53), req("polymarket", 40)];
    const result = optimizeExecutableBasket(requests, [
      { ok: false, priceCents: 54, averagePriceCents: 54, availableContracts: 12, levels: [{ priceCents: 54, contracts: 12 }] },
      { ok: true, priceCents: 40, averagePriceCents: 40, availableContracts: 18, levels: [{ priceCents: 40, contracts: 18 }] },
    ], 3, 0.03);

    expect(result.blockers).toEqual([]);
    expect(result.commonContracts).toBe(4);
    expect(result.requests.map((request) => request.sizeContracts)).toEqual([4, 4]);
    expect(result.requests.map((request) => request.limitPriceCents)).toEqual([54, 40]);
    expect(result.expectedProfit).toBeGreaterThanOrEqual(0.03);
  });

  it("keeps the original size when fresh higher asks remain profitable with buffered depth", () => {
    const result = optimizeExecutableBasket([req("kalshi", 53), req("polymarket", 40)], [
      { ok: true, priceCents: 54, averagePriceCents: 54, availableContracts: 18, levels: [{ priceCents: 54, contracts: 18 }] },
      { ok: true, priceCents: 40, averagePriceCents: 40, availableContracts: 18, levels: [{ priceCents: 40, contracts: 18 }] },
    ], 3, 0.03);
    expect(result.blockers).toEqual([]);
    expect(result.commonContracts).toBe(6);
    expect(result.requests[0].limitPriceCents).toBe(54);
  });

  it("walks deeper prices but chooses a smaller size when that produces more guaranteed profit", () => {
    const result = optimizeExecutableBasket([req("kalshi", 50), req("polymarket", 40)], [
      {
        ok: true,
        priceCents: 70,
        averagePriceCents: 60,
        availableContracts: 6,
        levels: [{ priceCents: 50, contracts: 3 }, { priceCents: 70, contracts: 3 }],
      },
      { ok: true, priceCents: 40, averagePriceCents: 40, availableContracts: 6, levels: [{ priceCents: 40, contracts: 6 }] },
    ], 1, 0.03);
    expect(result.blockers).toEqual([]);
    expect(result.commonContracts).toBeGreaterThanOrEqual(3);
    expect(result.commonContracts).toBeLessThan(6);
    expect(result.requests[0].limitPriceCents).toBe(70);
    expect(result.expectedProfit).toBeGreaterThan(0.2);
  });

  it("rejects after searching when a resized leg cannot clear the shared $1.01 minimum", () => {
    const result = optimizeExecutableBasket([req("kalshi", 90), req("polymarket", 5)], [
      { ok: true, priceCents: 90, averagePriceCents: 90, availableContracts: 18, levels: [{ priceCents: 90, contracts: 18 }] },
      { ok: true, priceCents: 5, averagePriceCents: 5, availableContracts: 18, levels: [{ priceCents: 5, contracts: 18 }] },
    ], 3, 0.03);
    expect(result.commonContracts).toBe(0);
    expect(result.blockers[0]).toMatch(/no profitable resized basket/);
    expect(result.blockers[0]).toMatch(/venue minimum/);
  });

  it("rejects the whole basket when any venue has no executable ladder", () => {
    const result = optimizeExecutableBasket([req("kalshi", 53), req("polymarket", 40)], [
      { ok: false, priceCents: 53, averagePriceCents: 53, availableContracts: 0, reason: "Kalshi has no asks" },
      { ok: true, priceCents: 40, averagePriceCents: 40, availableContracts: 18, levels: [{ priceCents: 40, contracts: 18 }] },
    ], 3, 0.03);
    expect(result.commonContracts).toBe(0);
    expect(result.blockers).toEqual(["Kalshi has no asks"]);
  });
});

describe("buildLiveOnlyQuotes — skip the REST probe when the live ladder alone suffices", () => {
  const req = (venueId: string, sizeContracts = 6): OrderRequest => ({
    venueId,
    marketId: `${venueId}:m`,
    nativeMarketId: `${venueId}:native`,
    nativeSide: "yes",
    outcome: "home",
    sizeContracts,
    limitPriceCents: 50,
  });

  it("builds a quote from the live ladder and allows skipping REST when every leg is fully covered", () => {
    const ladder = [{ priceCents: 48, contracts: 4 }, { priceCents: 49, contracts: 4 }];
    const result = buildLiveOnlyQuotes([req("kalshi", 6), req("polymarket", 6)], () => ladder);
    expect(result.canSkipRestProbe).toBe(true);
    expect(result.quotes[0]).toMatchObject({ ok: true, priceCents: 48, availableContracts: 8 });
    expect(result.quotes[1]).toMatchObject({ ok: true, priceCents: 48, availableContracts: 8 });
  });

  it("does NOT allow skipping REST when even one leg's live ladder is short of the required size", () => {
    const result = buildLiveOnlyQuotes([req("kalshi", 6), req("polymarket", 6)], (r) =>
      r.venueId === "kalshi" ? [{ priceCents: 48, contracts: 2 }] : [{ priceCents: 48, contracts: 20 }]
    );
    expect(result.canSkipRestProbe).toBe(false);
    expect(result.quotes[0]).toBeNull(); // short leg
    expect(result.quotes[1]).not.toBeNull(); // the other leg still got a usable quote, just unused when skip is false
  });

  it("does NOT allow skipping REST when a leg has no live data at all (e.g. SX.bet, or a stale/missing book)", () => {
    const result = buildLiveOnlyQuotes([req("kalshi", 6), req("sxbet", 6)], (r) => (r.venueId === "kalshi" ? [{ priceCents: 48, contracts: 10 }] : null));
    expect(result.canSkipRestProbe).toBe(false);
    expect(result.quotes[1]).toBeNull();
  });

  it("ignores empty-array live data the same as null (no depth is no depth)", () => {
    const result = buildLiveOnlyQuotes([req("kalshi", 6)], () => []);
    expect(result.canSkipRestProbe).toBe(false);
    expect(result.quotes[0]).toBeNull();
  });
});
