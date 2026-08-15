import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RiskReservationService, type AcquireRiskReservationInput } from "./riskReservation";

const tempDirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-risk-ledger-"));
  tempDirs.push(dir);
  return path.join(dir, "ledger.sqlite");
}

function request(overrides: Partial<AcquireRiskReservationInput> = {}): AcquireRiskReservationInput {
  return {
    opportunityId: "baseball:mlb:a|b:2026-08-10T00:00:00.000Z:moneyline:0",
    idempotencyKey: "opportunity:generation:1",
    quoteGeneration: "generation:1",
    matchKey: "baseball:mlb:a|b:2026-08-10T00:00:00.000Z",
    date: "20260810",
    ownerId: "worker-1",
    exposureUsd: 6,
    venueExposureUsd: { kalshi: 3, polymarket: 3 },
    maxExposureUsd: 100,
    maxOpenPositionsPerMatch: 1,
    perVenueCapsUsd: {},
    existingOpenPositions: [],
    legs: [
      { venueId: "kalshi", marketId: "k:a", nativeMarketId: "K-A", nativeSide: "yes", outcome: "home", sizeContracts: 6, limitPriceCents: 40 },
      { venueId: "polymarket", marketId: "p:b", nativeSide: "123", outcome: "away", sizeContracts: 6, limitPriceCents: 55 },
    ],
    ttlMs: 15_000,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("RiskReservationService", () => {
  it("grants exactly one reservation under true multi-process contention", async () => {
    const db = tempDb();
    const worker = path.join(__dirname, "riskReservation.stressWorker.mjs");
    const startAt = Date.now() + 750;
    const run = (index: number) => new Promise<unknown>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", worker, db, `process-${index}`, String(startAt)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(`stress worker exited ${code}: ${stderr}`));
        else resolve(JSON.parse(stdout));
      });
    });
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => run(index))) as Array<{ ok: boolean; code?: string }>;
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "duplicate")).toHaveLength(7);
  }, 15_000);

  it("grants exactly one owner across many independent database connections", () => {
    const db = tempDb();
    const services = Array.from({ length: 100 }, () => new RiskReservationService(db));
    try {
      const results = services.map((service, index) => service.acquire(request({ ownerId: `worker-${index}` })));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.code === "duplicate")).toHaveLength(99);
    } finally {
      services.forEach((service) => service.close());
    }
  });

  it("never exceeds the configured per-match slot count", () => {
    const service = new RiskReservationService(tempDb());
    try {
      const results = Array.from({ length: 20 }, (_, index) => service.acquire(request({
        idempotencyKey: `generation:${index}`,
        quoteGeneration: `generation:${index}`,
        maxOpenPositionsPerMatch: 3,
      })));
      expect(results.filter((result) => result.ok)).toHaveLength(3);
      expect(results.filter((result) => !result.ok && result.code === "match_cap")).toHaveLength(17);
    } finally {
      service.close();
    }
  });

  it("allows venue work for independent matches to overlap after atomic reservation", async () => {
    const service = new RiskReservationService(tempDb());
    let activeVenueCalls = 0;
    let peakVenueCalls = 0;
    try {
      const run = async (index: number) => {
        const matchKey = `baseball:mlb:away-${index}|home-${index}:2026-08-10T00:00:00.000Z`;
        const acquired = service.acquire(request({
          opportunityId: `${matchKey}:moneyline:0`,
          idempotencyKey: `independent:${index}`,
          quoteGeneration: `independent:${index}`,
          matchKey,
          ownerId: `worker-${index}`,
          maxExposureUsd: 1_000,
        }));
        expect(acquired.ok).toBe(true);
        if (!acquired.ok) return;
        expect(service.beginSubmission(acquired.reservation)).toBe(true);
        activeVenueCalls += 1;
        peakVenueCalls = Math.max(peakVenueCalls, activeVenueCalls);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeVenueCalls -= 1;
        service.markUncertain(acquired.reservation, null, "simulated venue completion");
      };

      await Promise.all(Array.from({ length: 8 }, (_, index) => run(index)));
      expect(peakVenueCalls).toBeGreaterThan(1);
      expect(service.list().filter((reservation) => reservation.state === "uncertain")).toHaveLength(8);
    } finally {
      service.close();
    }
  });

  it("atomically shares the global and venue exposure caps across matches", () => {
    const service = new RiskReservationService(tempDb());
    try {
      const first = service.acquire(request({ maxExposureUsd: 10, perVenueCapsUsd: { kalshi: 5 } }));
      const second = service.acquire(request({
        opportunityId: "baseball:mlb:c|d:2026-08-10T00:00:00.000Z:moneyline:0",
        idempotencyKey: "other:generation",
        quoteGeneration: "other:generation",
        matchKey: "baseball:mlb:c|d:2026-08-10T00:00:00.000Z",
        maxExposureUsd: 10,
        perVenueCapsUsd: { kalshi: 5 },
      }));
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, code: "exposure_cap" });

      const venueOnly = service.acquire(request({
        opportunityId: "baseball:mlb:e|f:2026-08-10T00:00:00.000Z:moneyline:0",
        idempotencyKey: "venue:generation",
        quoteGeneration: "venue:generation",
        matchKey: "baseball:mlb:e|f:2026-08-10T00:00:00.000Z",
        maxExposureUsd: 100,
        perVenueCapsUsd: { kalshi: 5 },
      }));
      expect(venueOnly).toMatchObject({ ok: false, code: "venue_cap" });
    } finally {
      service.close();
    }
  });

  it("counts legacy persisted positions without double-counting linked reservations", () => {
    const service = new RiskReservationService(tempDb());
    try {
      const result = service.acquire(request({
        maxOpenPositionsPerMatch: 1,
        existingOpenPositions: [{
          tradeId: "legacy-trade",
          date: "20260809",
          matchKey: "baseball:mlb:a|b:2026-08-10T00:00:00.000Z",
          exposureUsd: 4,
          venueExposureUsd: { kalshi: 2, polymarket: 2 },
        }],
      }));
      expect(result).toMatchObject({ ok: false, code: "match_cap" });
    } finally {
      service.close();
    }
  });

  it("fences expired never-submitted owners but never expires a submitting owner", async () => {
    const db = tempDb();
    const service = new RiskReservationService(db);
    try {
      const expiring = service.acquire(request({ ttlMs: 10 }));
      expect(expiring.ok).toBe(true);
      if (!expiring.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const replacement = service.acquire(request({ ownerId: "replacement" }));
      expect(replacement.ok).toBe(true);
      expect(service.beginSubmission(expiring.reservation)).toBe(false);
      if (!replacement.ok) return;
      expect(service.beginSubmission(replacement.reservation)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 25));
      const afterCrash = new RiskReservationService(db);
      try {
        const duplicate = afterCrash.acquire(request({ ownerId: "after-crash" }));
        expect(duplicate).toMatchObject({ ok: false, code: "duplicate" });
      } finally {
        afterCrash.close();
      }
    } finally {
      service.close();
    }
  });

  it("requires the exact fencing token and owner for every transition", () => {
    const service = new RiskReservationService(tempDb());
    try {
      const result = service.acquire(request());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(service.beginSubmission({ ...result.reservation, fencingToken: result.reservation.fencingToken + 1 })).toBe(false);
      expect(service.beginSubmission({ ...result.reservation, ownerId: "stale-worker" })).toBe(false);
      expect(service.beginSubmission(result.reservation)).toBe(true);
      expect(service.markCommitted({ ...result.reservation, ownerId: "stale-worker" }, "trade-1")).toBe(false);
      expect(service.markCommitted(result.reservation, "trade-1")).toBe(true);
      expect(service.releaseByTradeId("trade-1", "settled")).toBe(true);
      expect(service.get(result.reservation.id)?.state).toBe("released");
      expect(service.listEvents().map((event) => event.type)).toEqual(expect.arrayContaining([
        "reserved",
        "submission_started",
        "reservation_committed",
        "released_trade_terminal",
      ]));
    } finally {
      service.close();
    }
  });

  it("persists exact leg plans and acknowledgements behind the reservation fence", () => {
    const db = tempDb();
    const service = new RiskReservationService(db);
    try {
      const result = service.acquire(request());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservation.legs).toHaveLength(2);
      expect(result.reservation.legs[0]).toMatchObject({
        venueId: "kalshi",
        sizeContracts: 6,
        limitPriceCents: 40,
        submissionState: "planned",
      });
      expect(result.reservation.legs[0].clientOrderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(result.reservation.legs[0].clientOrderId).not.toBe(result.reservation.legs[1].clientOrderId);
      expect(service.markLegSubmitting(result.reservation, 0)).toBe(false);
      expect(service.beginSubmission(result.reservation)).toBe(true);
      expect(service.markLegSubmitting(result.reservation, 0)).toBe(true);
      expect(service.markLegSubmitting(result.reservation, 1)).toBe(true);
      expect(service.recordLegResult(result.reservation, 0, {
        orderId: "venue-order-1",
        confirmationId: "confirmation-1",
        filledContracts: 6,
        avgPriceCents: 39,
        status: "filled",
      })).toBe(true);
      expect(service.markLegUncertain(result.reservation, 1, "socket reset after POST")).toBe(true);
      service.close();

      const restarted = new RiskReservationService(db);
      try {
        const persisted = restarted.get(result.reservation.id);
        expect(persisted?.state).toBe("submitting");
        expect(persisted?.legs[0]).toMatchObject({
          submissionState: "acknowledged",
          venueOrderId: "venue-order-1",
          confirmationId: "confirmation-1",
          filledContracts: 6,
          averagePriceCents: 39,
        });
        expect(persisted?.legs[1]).toMatchObject({ submissionState: "uncertain", error: "socket reset after POST" });
      } finally {
        restarted.close();
      }
    } finally {
      try { service.close(); } catch { /* already closed for restart simulation */ }
    }
  });

  it("allocates one durable recovery attempt at a time with a fresh deterministic id", () => {
    const service = new RiskReservationService(tempDb());
    try {
      const acquired = service.acquire(request());
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      expect(service.beginSubmission(acquired.reservation)).toBe(true);
      expect(service.markLegSubmitting(acquired.reservation, 0)).toBe(true);
      expect(service.recordLegResult(acquired.reservation, 0, {
        orderId: "primary-zero",
        filledContracts: 0,
        avgPriceCents: 40,
        status: "unfilled",
      })).toBe(true);

      const first = service.allocateRecoveryAttempt(acquired.reservation, 0, 6, 50, 3);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.attempt.clientOrderId).not.toBe(acquired.reservation.legs[0].clientOrderId);
      expect(service.allocateRecoveryAttempt(acquired.reservation, 0, 6, 50, 3)).toMatchObject({ ok: false, code: "active" });
      expect(service.markRecoverySubmitting(acquired.reservation, 0, 1)).toBe(true);
      expect(service.recordRecoveryResult(acquired.reservation, 0, 1, {
        orderId: "recovery-zero",
        filledContracts: 0,
        avgPriceCents: 50,
        status: "unfilled",
      })).toBe(true);

      const second = service.allocateRecoveryAttempt(acquired.reservation, 0, 6, 50, 3);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.attempt.attemptNumber).toBe(2);
      expect(second.attempt.clientOrderId).not.toBe(first.attempt.clientOrderId);
      expect(service.get(acquired.reservation.id)?.recoveryAttempts).toHaveLength(2);
    } finally {
      service.close();
    }
  });

  it("atomically prevents two workers from owning the same recovery attempt", () => {
    const db = tempDb();
    const owner = new RiskReservationService(db);
    const competitor = new RiskReservationService(db);
    try {
      const acquired = owner.acquire(request());
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      expect(owner.beginSubmission(acquired.reservation)).toBe(true);
      expect(owner.markLegSubmitting(acquired.reservation, 0)).toBe(true);
      expect(owner.recordLegResult(acquired.reservation, 0, {
        orderId: "primary-zero",
        filledContracts: 0,
        avgPriceCents: 40,
        status: "unfilled",
      })).toBe(true);
      const results = [owner, competitor].map((candidate) =>
        candidate.allocateRecoveryAttempt(acquired.reservation, 0, 6, 50, 3)
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.code === "active")).toHaveLength(1);
    } finally {
      owner.close();
      competitor.close();
    }
  });

  it("keeps uncertain submission outcomes exposure-blocking", () => {
    const service = new RiskReservationService(tempDb());
    try {
      const first = service.acquire(request());
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(service.beginSubmission(first.reservation)).toBe(true);
      expect(service.markUncertain(first.reservation, null, "process died after venue request")).toBe(true);
      const retry = service.acquire(request({ ownerId: "retry-worker" }));
      expect(retry).toMatchObject({ ok: false, code: "duplicate" });
      expect(service.get(first.reservation.id)?.state).toBe("uncertain");
    } finally {
      service.close();
    }
  });
});
