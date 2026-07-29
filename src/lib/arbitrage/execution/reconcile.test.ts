import { describe, expect, it } from "vitest";
import { applyReconciliation, reconcileLegs, type LegReconciliation } from "./reconcile";
import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

const req = (venueId: string): OrderRequest => ({ venueId, marketId: `${venueId}:m`, outcome: "over", sizeContracts: 10, limitPriceCents: 50 });
const filled = (venueId: string, orderId: string | null, n = 10): OrderResult => ({
  ok: n > 0,
  orderId,
  filledContracts: n,
  avgPriceCents: 50,
  status: n >= 10 ? "filled" : n > 0 ? "partial" : "unfilled",
});

describe("applyReconciliation", () => {
  const results = [filled("kalshi", "k1"), filled("sxbet", "s1")];

  it("forces a settlement-failed leg to zero fill so it can be flagged naked", () => {
    const recon: LegReconciliation[] = [
      { venue: "kalshi", orderId: "k1", confirmation: { status: "settled" } },
      { venue: "sxbet", orderId: "s1", confirmation: { status: "failed", filledContracts: 0 } },
    ];
    const out = applyReconciliation(results, recon);
    expect(out[0].filledContracts).toBe(10); // settled leg untouched
    expect(out[1].filledContracts).toBe(0); // failed leg zeroed
    expect(out[1].ok).toBe(false);
  });

  it("adopts a concrete settled fill count", () => {
    const recon: LegReconciliation[] = [
      { venue: "kalshi", orderId: "k1", confirmation: { status: "settled", filledContracts: 7 } },
      { venue: "sxbet", orderId: "s1", confirmation: null },
    ];
    const out = applyReconciliation(results, recon, [req("kalshi"), req("sxbet")]);
    expect(out[0].filledContracts).toBe(7);
    expect(out[0].status).toBe("partial");
    expect(out[0].ok).toBe(true);
    expect(out[1].filledContracts).toBe(10); // no confirmation → placement stands
  });

  it("clears stale placement errors when reconciliation finds a fill", () => {
    const pendingZero: OrderResult = { ...filled("predictfun", "pf1", 0), error: "accepted but not reported filled" };
    const out = applyReconciliation(
      [pendingZero],
      [{ venue: "predictfun", orderId: "pf1", confirmation: { status: "settled", filledContracts: 4.9 } }],
      [{ ...req("predictfun"), sizeContracts: 5 }]
    );
    expect(out[0]).toMatchObject({ ok: true, filledContracts: 4.9, status: "partial" });
    expect(out[0].error).toBeUndefined();
  });

  it("never downgrades on pending/unknown (no false naked flags)", () => {
    const recon: LegReconciliation[] = [
      { venue: "kalshi", orderId: "k1", confirmation: { status: "pending" } },
      { venue: "sxbet", orderId: "s1", confirmation: { status: "unknown" } },
    ];
    const out = applyReconciliation(results, recon);
    expect(out[0].filledContracts).toBe(10);
    expect(out[1].filledContracts).toBe(10);
  });
});

describe("reconcileLegs", () => {
  function adapter(id: string, confirm?: FillConfirmation): ExecutionAdapter {
    return {
      id,
      supportsLive: () => true,
      getBalanceUsd: async () => null,
      placeOrder: async () => filled(id, `${id}1`),
      confirmFill: confirm ? async () => confirm : undefined,
    };
  }

  it("skips legs whose adapter has no confirmFill and reports settled ones", async () => {
    const adapters = [adapter("kalshi"), adapter("sxbet", { status: "settled" })];
    const requests = [req("kalshi"), req("sxbet")];
    const results = [filled("kalshi", "kalshi1"), filled("sxbet", "sxbet1")];
    const recon = await reconcileLegs(adapters, requests, results);
    expect(recon[0].confirmation).toBeNull(); // no confirmFill → untouched
    expect(recon[1].confirmation?.status).toBe("settled");
  });

  it("skips legs that placed no order", async () => {
    const adapters = [adapter("sxbet", { status: "settled" })];
    const requests = [req("sxbet")];
    const results = [filled("sxbet", null, 0)]; // rejected, no orderId
    const recon = await reconcileLegs(adapters, requests, results);
    expect(recon[0].confirmation).toBeNull();
  });
});
