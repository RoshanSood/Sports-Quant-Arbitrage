import type { ExecCreds } from "./registry";
import { getAdapter } from "./registry";
import { getRiskReservationService, type RecoveryAttempt, type ReservationLeg, type RiskReservationService } from "./riskReservation";
import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

export type ReservationReconciliationSummary = {
  checkedReservations: number;
  checkedLegs: number;
  recoveredLegs: number;
  recoveredAttempts: number;
  releasedZeroFillReservations: number;
  stillUncertainReservations: number;
  errors: string[];
};

function requestFromLeg(leg: ReservationLeg): OrderRequest {
  return {
    venueId: leg.venueId,
    marketId: leg.marketId,
    nativeMarketId: leg.nativeMarketId,
    nativeSide: leg.nativeSide,
    outcome: leg.outcome,
    sizeContracts: leg.sizeContracts,
    limitPriceCents: leg.limitPriceCents,
    clientOrderId: leg.clientOrderId,
  };
}

function requestFromAttempt(leg: ReservationLeg, attempt: RecoveryAttempt): OrderRequest {
  return {
    venueId: leg.venueId,
    marketId: leg.marketId,
    nativeMarketId: leg.nativeMarketId,
    nativeSide: leg.nativeSide,
    outcome: leg.outcome,
    sizeContracts: attempt.sizeContracts,
    limitPriceCents: attempt.limitPriceCents,
    clientOrderId: attempt.clientOrderId,
  };
}

function resultFromConfirmation(leg: ReservationLeg, confirmation: FillConfirmation): OrderResult | null {
  if (confirmation.status === "unknown") return null;
  const filledContracts = confirmation.filledContracts ?? leg.filledContracts;
  return {
    ok: filledContracts > 0,
    orderId: leg.venueOrderId,
    confirmationId: leg.confirmationId,
    filledContracts,
    avgPriceCents: confirmation.avgPriceCents ?? leg.averagePriceCents ?? leg.limitPriceCents,
    status: confirmation.status === "settled"
      ? filledContracts + 1e-9 >= leg.sizeContracts ? "filled" : filledContracts > 0 ? "partial" : "unfilled"
      : confirmation.status === "pending" ? "pending" : "unfilled",
    error: confirmation.error,
  };
}

type AdapterFactory = (venueId: string, creds?: ExecCreds) => ExecutionAdapter;

async function recoverLeg(leg: ReservationLeg, creds: ExecCreds | undefined, adapterFor: AdapterFactory): Promise<OrderResult | null> {
  const adapter = adapterFor(leg.venueId, creds);
  if (!adapter.supportsLive()) return null;
  const request = requestFromLeg(leg);
  const confirmationId = leg.confirmationId ?? leg.venueOrderId;
  if (confirmationId && adapter.confirmFill) {
    const confirmation = await adapter.confirmFill(confirmationId, request);
    return resultFromConfirmation(leg, confirmation);
  }
  if (adapter.recoverOrder) return adapter.recoverOrder(request);
  return null;
}

async function recoverAttempt(
  leg: ReservationLeg,
  attempt: RecoveryAttempt,
  creds: ExecCreds | undefined,
  adapterFor: AdapterFactory
): Promise<OrderResult | null> {
  if (attempt.submissionState === "planned") {
    return {
      ok: false,
      orderId: null,
      filledContracts: 0,
      avgPriceCents: attempt.limitPriceCents,
      status: "unfilled",
      error: "process stopped before persisted recovery attempt entered submission",
    };
  }
  const adapter = adapterFor(leg.venueId, creds);
  if (!adapter.supportsLive()) return null;
  const request = requestFromAttempt(leg, attempt);
  const confirmationId = attempt.confirmationId ?? attempt.venueOrderId;
  if (confirmationId && adapter.confirmFill) {
    const confirmation = await adapter.confirmFill(confirmationId, request);
    if (confirmation.status === "unknown") return null;
    const filledContracts = confirmation.filledContracts ?? attempt.filledContracts;
    return {
      ok: filledContracts > 0,
      orderId: attempt.venueOrderId,
      confirmationId: attempt.confirmationId,
      filledContracts,
      avgPriceCents: confirmation.avgPriceCents ?? attempt.averagePriceCents ?? attempt.limitPriceCents,
      status: confirmation.status === "pending"
        ? "pending"
        : filledContracts + 1e-9 >= attempt.sizeContracts ? "filled" : filledContracts > 0 ? "partial" : "unfilled",
      error: confirmation.error,
    };
  }
  if (adapter.recoverOrder) return adapter.recoverOrder(request);
  return null;
}

/**
 * Read-only venue recovery for reservations left submitting/uncertain by a restart or a
 * lost acknowledgement. It never places or retries an order. Capacity is released only
 * when every persisted leg is positively reconciled as terminal zero-fill.
 */
export async function reconcileOutstandingReservations(options: {
  creds?: ExecCreds;
  service?: RiskReservationService;
  adapterFor?: AdapterFactory;
} = {}): Promise<ReservationReconciliationSummary> {
  const service = options.service ?? getRiskReservationService();
  const adapterFor = options.adapterFor ?? ((venueId, creds) => getAdapter(venueId, "live", creds));
  const candidates = service.list().filter((reservation) => reservation.state === "submitting" || reservation.state === "uncertain");
  const summary: ReservationReconciliationSummary = {
    checkedReservations: candidates.length,
    checkedLegs: 0,
    recoveredLegs: 0,
    recoveredAttempts: 0,
    releasedZeroFillReservations: 0,
    stillUncertainReservations: 0,
    errors: [],
  };

  for (const reservation of candidates) {
    for (const leg of reservation.legs) {
      const terminal = leg.submissionState === "acknowledged" && ["filled", "partial", "unfilled", "rejected"].includes(leg.resultStatus ?? "");
      if (terminal) continue;
      summary.checkedLegs += 1;
      try {
        const recovered = await recoverLeg(leg, options.creds, adapterFor);
        if (!recovered) continue;
        if (service.recordLegResult(reservation, leg.index, recovered)) summary.recoveredLegs += 1;
      } catch (error) {
        summary.errors.push(`${reservation.id} leg ${leg.index}: ${String(error)}`);
      }
    }
    for (const attempt of reservation.recoveryAttempts) {
      const terminal = attempt.submissionState === "acknowledged" && ["filled", "partial", "unfilled", "rejected"].includes(attempt.resultStatus ?? "");
      if (terminal) continue;
      summary.checkedLegs += 1;
      const leg = reservation.legs.find((candidate) => candidate.index === attempt.legIndex);
      if (!leg) {
        summary.errors.push(`${reservation.id} recovery ${attempt.legIndex}/${attempt.attemptNumber}: original leg missing`);
        continue;
      }
      try {
        const recovered = await recoverAttempt(leg, attempt, options.creds, adapterFor);
        if (!recovered) continue;
        if (service.recordRecoveryResult(reservation, attempt.legIndex, attempt.attemptNumber, recovered)) {
          summary.recoveredAttempts += 1;
        }
      } catch (error) {
        summary.errors.push(`${reservation.id} recovery ${attempt.legIndex}/${attempt.attemptNumber}: ${String(error)}`);
      }
    }
    const refreshed = service.get(reservation.id);
    if (!refreshed) continue;
    if (service.releaseAfterReconciledZeroFill(refreshed, "all persisted legs reconciled as terminal zero-fill")) {
      summary.releasedZeroFillReservations += 1;
    } else if (refreshed.state === "submitting" || refreshed.state === "uncertain") {
      service.markUncertain(refreshed, refreshed.tradeId, "restart reconciliation could not prove every leg terminal zero-fill");
      summary.stillUncertainReservations += 1;
    }
  }
  return summary;
}
