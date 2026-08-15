import { describe, expect, it } from "vitest";
import type { ArbLeg } from "@/types/arbitrage";
import {
  applyEconomicPriceCushion,
  applyVenueAwarePriceCushion,
  buildLiveOnlyQuotes,
  fragileVenueFirstOrder,
  commonExecutableRequests,
  checkLiveFillability,
  confirmPendingAnchor,
  liveVenueMinimumStakeBlockers,
  optimizeExecutableBasket,
  isPolymarketKalshiPair,
  recoverMissingHedge,
  recoveryPathBlockers,
  resizeHedgeToAnchorFill,
  shouldSequenceFragileVenuePair,
} from "./executor";
import type { PreparedContext } from "../executionPipeline";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";
import { RiskReservationService, type AcquireRiskReservationInput } from "./riskReservation";

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

  it("persists unique recovery ids and submits only the remaining imbalance", async () => {
    const ledger = new RiskReservationService(":memory:");
    try {
      const input: AcquireRiskReservationInput = {
        opportunityId: "baseball:mlb:a|b:2026-08-10T00:00:00.000Z:moneyline:0",
        idempotencyKey: "durable-recovery:generation",
        quoteGeneration: "generation",
        matchKey: "baseball:mlb:a|b:2026-08-10T00:00:00.000Z",
        date: "20260810",
        ownerId: "worker",
        exposureUsd: 6,
        venueExposureUsd: { polymarket: 3, kalshi: 3 },
        maxExposureUsd: 100,
        maxOpenPositionsPerMatch: 1,
        perVenueCapsUsd: {},
        existingOpenPositions: [],
        legs: [
          { venueId: "polymarket", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 65 },
          { venueId: "kalshi", marketId: "k", nativeMarketId: "K", nativeSide: "no", outcome: "away", sizeContracts: 6, limitPriceCents: 30 },
        ],
      };
      const acquired = ledger.acquire(input);
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      expect(ledger.beginSubmission(acquired.reservation)).toBe(true);
      for (const legPlan of acquired.reservation.legs) expect(ledger.markLegSubmitting(acquired.reservation, legPlan.index)).toBe(true);
      expect(ledger.recordLegResult(acquired.reservation, 0, filled)).toBe(true);
      expect(ledger.recordLegResult(acquired.reservation, 1, missed)).toBe(true);

      const submitted: OrderRequest[] = [];
      const adapter = recoveryAdapter("kalshi", { priceCents: 31, availableContracts: 20 }, missed);
      adapter.placeOrder = async (request) => {
        submitted.push({ ...request });
        return submitted.length === 1
          ? { ...missed, orderId: "recovery-zero" }
          : { ok: true, orderId: "recovery-fill", filledContracts: request.sizeContracts, avgPriceCents: 31, status: "filled" };
      };
      const result = await recoverMissingHedge(
        recoveryContext(),
        [recoveryAdapter("polymarket", { priceCents: 65, availableContracts: 20 }, filled), adapter],
        requests.map((request, index) => ({ ...request, clientOrderId: acquired.reservation.legs[index].clientOrderId })),
        [filled, missed],
        { reservation: acquired.reservation, service: ledger }
      );
      expect(submitted).toHaveLength(2);
      expect(new Set(submitted.map((request) => request.clientOrderId)).size).toBe(2);
      expect(submitted.every((request) => request.clientOrderId !== acquired.reservation.legs[1].clientOrderId)).toBe(true);
      expect(submitted.map((request) => request.sizeContracts)).toEqual([6, 6]);
      expect(result.results[1]).toMatchObject({ filledContracts: 6, status: "filled" });
      expect(ledger.get(acquired.reservation.id)?.recoveryAttempts).toHaveLength(2);
    } finally {
      ledger.close();
    }
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

describe("Polymarket-first Kalshi hedge cushion", () => {
  it("keeps the Polymarket FOK limit fixed and gives the movement allowance to Kalshi", () => {
    const requests: OrderRequest[] = [
      { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 45 },
      { venueId: "polymarket", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 45 },
    ];
    const result = applyVenueAwarePriceCushion(
      requests,
      [leg("kalshi", 6, 45), leg("polymarket", 6, 45)],
      0.03,
      10
    );

    expect(result.safe).toBe(true);
    expect(result.cushionCents).toBeGreaterThan(0);
    expect(result.requests[1].limitPriceCents).toBe(45);
    expect(result.requests[0].limitPriceCents).toBe(45 + result.cushionCents);
  });

  it("retains shared cushioning for pairings that still submit concurrently", () => {
    const requests: OrderRequest[] = [
      { venueId: "predictfun", marketId: "p", outcome: "home", sizeContracts: 6, limitPriceCents: 45 },
      { venueId: "kalshi", marketId: "k", outcome: "away", sizeContracts: 6, limitPriceCents: 45 },
    ];
    const result = applyVenueAwarePriceCushion(
      requests,
      [leg("predictfun", 6, 45), leg("kalshi", 6, 45)],
      0.03,
      10
    );

    expect(result.requests[0].limitPriceCents).toBe(result.requests[1].limitPriceCents);
  });
});

describe("Polymarket pending-anchor confirmation", () => {
  const request: OrderRequest = {
    venueId: "polymarket",
    marketId: "polymarket:m",
    outcome: "home",
    sizeContracts: 6,
    limitPriceCents: 45,
  };
  const pending: OrderResult = {
    ok: true,
    orderId: "poly-order",
    filledContracts: 0,
    avgPriceCents: 45,
    status: "pending",
  };

  function adapter(confirmations: Array<Awaited<ReturnType<NonNullable<ExecutionAdapter["confirmFill"]>>>>): ExecutionAdapter {
    let index = 0;
    return {
      id: "polymarket",
      supportsLive: () => true,
      getBalanceUsd: async () => null,
      placeOrder: async () => pending,
      confirmFill: async () => confirmations[Math.min(index++, confirmations.length - 1)],
    };
  }

  it("turns a delayed acknowledgement into the confirmed fill used for the hedge", async () => {
    const confirmed = await confirmPendingAnchor(adapter([
      { status: "pending" },
      { status: "settled", filledContracts: 6, avgPriceCents: 44 },
    ]), request, pending, { attempts: 2, delayMs: 0 });

    expect(confirmed.result).toMatchObject({ ok: true, status: "filled", filledContracts: 6, avgPriceCents: 44 });
  });

  it("retries a transient unknown confirmation instead of withholding the hedge immediately", async () => {
    const confirmed = await confirmPendingAnchor(adapter([
      { status: "unknown" },
      { status: "settled", filledContracts: 6, avgPriceCents: 44 },
    ]), request, pending, { attempts: 2, delayMs: 0 });
    expect(confirmed.result).toMatchObject({ status: "filled", filledContracts: 6 });
  });

  it("preserves an unresolved acknowledgement as pending instead of inventing a zero fill", async () => {
    const unresolved = await confirmPendingAnchor(adapter([{ status: "pending" }]), request, pending, { attempts: 2, delayMs: 0 });
    expect(unresolved.result).toMatchObject({ ok: true, status: "pending", filledContracts: 0, orderId: "poly-order" });
  });

  it("returns an explicit failed confirmation as terminal zero fill", async () => {
    const failed = await confirmPendingAnchor(adapter([{ status: "failed", filledContracts: 0, error: "not matched" }]), request, pending, { attempts: 1, delayMs: 0 });
    expect(failed.result).toMatchObject({ ok: false, status: "unfilled", filledContracts: 0, error: "not matched" });
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

  it("blocks Polymarket fills below both its $1.01 notional and one-contract floors", () => {
    expect(liveVenueMinimumStakeBlockers([leg("polymarket", 0.9, 90)])).toEqual([
      "Polymarket Home stake $0.81 is below minimum $1.01",
      "Polymarket Home size 0.90 is below minimum 1.00 contracts",
    ]);
  });

  it("blocks a one-contract Polymarket fill below $1.01", () => {
    expect(
      liveVenueMinimumStakeBlockers([leg("polymarket", 1, 60), leg("kalshi", 1, 5)])
    ).toEqual(["Polymarket Home stake $0.60 is below minimum $1.01"]);
  });

  it("allows Polymarket and Kalshi once the Polymarket notional clears $1.01", () => {
    expect(
      liveVenueMinimumStakeBlockers([leg("polymarket", 2, 60), leg("kalshi", 2, 5)])
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

  it("sequences Polymarket first when paired with Kalshi — re-introduced 2026-08-11 (see fragileVenueFirstOrder's comment)", () => {
    const requests = [req("kalshi"), req("polymarket")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(true);
    expect(fragileVenueFirstOrder(requests)).toEqual([1, 0]); // polymarket (index 1) first
    expect(fragileVenueFirstOrder([req("polymarket"), req("kalshi")])).toEqual([0, 1]); // already polymarket-first
  });

  it("identifies only the exact two-venue Polymarket/Kalshi pair", () => {
    const requests = [req("kalshi"), req("polymarket")];
    expect(isPolymarketKalshiPair(requests)).toBe(true);
    expect(isPolymarketKalshiPair([req("sxbet"), req("polymarket")])).toBe(false);
  });

  it("resizes Kalshi to a confirmed partial Polymarket fill instead of skipping the hedge", () => {
    const kalshi = req("kalshi");
    expect(resizeHedgeToAnchorFill(kalshi, 4.876)).toMatchObject({ sizeContracts: 4.87 });
  });

  it("does not submit a hedge when the anchor filled zero or the result is below the venue minimum", () => {
    expect(resizeHedgeToAnchorFill(req("kalshi"), 0)).toBeNull();
    expect(resizeHedgeToAnchorFill({ ...req("kalshi"), limitPriceCents: 10 }, 0.99)).toBeNull();
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

  it("SX.bet still outranks Polymarket when both are present alongside Kalshi", () => {
    const requests = [req("kalshi"), req("polymarket"), req("sxbet")];
    expect(fragileVenueFirstOrder(requests)).toEqual([2, 0, 1]); // sxbet (index 2) first
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

  it("rejects a resized basket whose Polymarket leg is below $1.01", () => {
    const result = optimizeExecutableBasket([req("kalshi", 90), req("polymarket", 5)], [
      { ok: true, priceCents: 90, averagePriceCents: 90, availableContracts: 3, levels: [{ priceCents: 90, contracts: 3 }] },
      { ok: true, priceCents: 5, averagePriceCents: 5, availableContracts: 3, levels: [{ priceCents: 5, contracts: 3 }] },
    ], 3, 0);
    expect(result.commonContracts).toBe(0);
    expect(result.blockers[0]).toContain("venue minimum");
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
    expect(result.quotes[0]).toMatchObject({ ok: true, priceCents: 49, availableContracts: 8 });
    expect(result.quotes[0]?.averagePriceCents).toBeCloseTo(48.333333, 5);
    expect(result.quotes[1]).toMatchObject({ ok: true, priceCents: 49, availableContracts: 8 });
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
