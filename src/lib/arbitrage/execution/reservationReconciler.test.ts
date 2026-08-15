import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RiskReservationService, type AcquireRiskReservationInput } from "./riskReservation";
import { reconcileOutstandingReservations } from "./reservationReconciler";
import type { ExecutionAdapter, OrderResult } from "./types";

const tempDirs: string[] = [];

function service(): RiskReservationService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-reconcile-"));
  tempDirs.push(dir);
  return new RiskReservationService(path.join(dir, "ledger.sqlite"));
}

function input(): AcquireRiskReservationInput {
  return {
    opportunityId: "baseball:mlb:a|b:2026-08-10T00:00:00.000Z:moneyline:0",
    idempotencyKey: "reconcile:generation",
    quoteGeneration: "reconcile:generation",
    matchKey: "baseball:mlb:a|b:2026-08-10T00:00:00.000Z",
    date: "20260810",
    ownerId: "crashed-worker",
    exposureUsd: 6,
    venueExposureUsd: { kalshi: 3, cloudbet: 3 },
    maxExposureUsd: 100,
    maxOpenPositionsPerMatch: 1,
    perVenueCapsUsd: {},
    existingOpenPositions: [],
    legs: [
      { venueId: "kalshi", marketId: "k:a", nativeMarketId: "K-A", nativeSide: "yes", outcome: "home", sizeContracts: 6, limitPriceCents: 40 },
      { venueId: "cloudbet", marketId: "c:b", nativeMarketId: "C-B", nativeSide: "away", outcome: "away", sizeContracts: 6, limitPriceCents: 55 },
    ],
  };
}

function recoveryAdapter(result: OrderResult | null | Error): ExecutionAdapter {
  return {
    id: "recovery-test",
    supportsLive: () => true,
    getBalanceUsd: async () => 100,
    quoteOrder: async (request) => ({ ok: true, priceCents: request.limitPriceCents, averagePriceCents: request.limitPriceCents, availableContracts: request.sizeContracts }),
    placeOrder: vi.fn(async () => { throw new Error("reconciler must never place an order"); }),
    recoverOrder: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function prepareCrashedReservation(ledger: RiskReservationService) {
  const acquired = ledger.acquire(input());
  if (!acquired.ok) throw new Error(acquired.reason);
  if (!ledger.beginSubmission(acquired.reservation)) throw new Error("begin submission failed");
  for (const leg of acquired.reservation.legs) {
    if (!ledger.markLegSubmitting(acquired.reservation, leg.index)) throw new Error("leg fence failed");
  }
  return acquired.reservation;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("reservation restart reconciliation", () => {
  it("releases capacity only when every venue proves terminal zero-fill", async () => {
    const ledger = service();
    try {
      const reservation = prepareCrashedReservation(ledger);
      const adapter = recoveryAdapter({ ok: false, orderId: "known", filledContracts: 0, avgPriceCents: 40, status: "unfilled" });
      const summary = await reconcileOutstandingReservations({ service: ledger, adapterFor: () => adapter });
      expect(summary).toMatchObject({ checkedReservations: 1, recoveredLegs: 2, releasedZeroFillReservations: 1, stillUncertainReservations: 0 });
      expect(ledger.get(reservation.id)?.state).toBe("released");
      expect(adapter.placeOrder).not.toHaveBeenCalled();
    } finally {
      ledger.close();
    }
  });

  it("keeps any recovered fill exposure-blocking", async () => {
    const ledger = service();
    try {
      const reservation = prepareCrashedReservation(ledger);
      const summary = await reconcileOutstandingReservations({
        service: ledger,
        adapterFor: (venue) => recoveryAdapter(venue === "kalshi"
          ? { ok: true, orderId: "filled-order", filledContracts: 6, avgPriceCents: 40, status: "filled" }
          : { ok: false, orderId: "empty-order", filledContracts: 0, avgPriceCents: 55, status: "unfilled" }),
      });
      expect(summary).toMatchObject({ recoveredLegs: 2, releasedZeroFillReservations: 0, stillUncertainReservations: 1 });
      expect(ledger.get(reservation.id)?.state).toBe("uncertain");
    } finally {
      ledger.close();
    }
  });

  it("fails closed when a recovery lookup errors", async () => {
    const ledger = service();
    try {
      const reservation = prepareCrashedReservation(ledger);
      const summary = await reconcileOutstandingReservations({ service: ledger, adapterFor: () => recoveryAdapter(new Error("venue unavailable")) });
      expect(summary.errors).toHaveLength(2);
      expect(summary.stillUncertainReservations).toBe(1);
      expect(ledger.get(reservation.id)?.state).toBe("uncertain");
    } finally {
      ledger.close();
    }
  });

  it("reconciles a persisted recovery attempt after restart without placing another order", async () => {
    const ledger = service();
    try {
      const reservation = prepareCrashedReservation(ledger);
      expect(ledger.recordLegResult(reservation, 0, {
        orderId: "kalshi-primary",
        filledContracts: 6,
        avgPriceCents: 40,
        status: "filled",
      })).toBe(true);
      expect(ledger.recordLegResult(reservation, 1, {
        orderId: "cloudbet-primary-zero",
        filledContracts: 0,
        avgPriceCents: 55,
        status: "unfilled",
      })).toBe(true);
      const allocated = ledger.allocateRecoveryAttempt(reservation, 1, 6, 65, 3);
      expect(allocated.ok).toBe(true);
      if (!allocated.ok) return;
      expect(ledger.markRecoverySubmitting(reservation, 1, allocated.attempt.attemptNumber)).toBe(true);

      const adapter = recoveryAdapter({
        ok: true,
        orderId: "cloudbet-recovery",
        filledContracts: 6,
        avgPriceCents: 60,
        status: "filled",
      });
      const summary = await reconcileOutstandingReservations({ service: ledger, adapterFor: () => adapter });
      expect(summary).toMatchObject({ recoveredAttempts: 1, stillUncertainReservations: 1 });
      expect(ledger.get(reservation.id)?.recoveryAttempts[0]).toMatchObject({
        submissionState: "acknowledged",
        venueOrderId: "cloudbet-recovery",
        filledContracts: 6,
        resultStatus: "filled",
      });
      expect(adapter.placeOrder).not.toHaveBeenCalled();
    } finally {
      ledger.close();
    }
  });
});
