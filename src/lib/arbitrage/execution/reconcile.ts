// Post-execution settlement reconciliation (manual §2 — reconciliation must work before
// live is trusted). After legs are placed we RE-QUERY each venue to confirm the order
// actually settled, rather than trusting the placement ack. This matters for on-chain
// venues (SX.bet acks PENDING then settles SUCCESS/FAILED on-chain). Bounded polling so
// it never hangs the request; only downgrades a leg on an EXPLICIT "failed" — an
// unknown/pending result never causes a false naked flag.

import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

export type LegReconciliation = {
  venue: string;
  orderId: string | null;
  confirmation: FillConfirmation | null;
};

const ATTEMPTS = Math.max(1, Number(process.env.ARB_RECON_ATTEMPTS) || 3);
const DELAY_MS = Math.max(0, Number(process.env.ARB_RECON_DELAY_MS) || 1500);

const isFinalized = (c: FillConfirmation | null): boolean =>
  c != null && c.status !== "pending" && c.status !== "unknown";

// Poll confirmFill for each leg that placed an order, until all resolve or attempts run
// out. Legs whose adapter has no confirmFill (Kalshi IOC / Polymarket FOK are atomic)
// are left as-is. Returns one entry per input leg (aligned by index).
export async function reconcileLegs(
  adapters: ExecutionAdapter[],
  requests: OrderRequest[],
  results: OrderResult[]
): Promise<LegReconciliation[]> {
  const recon: LegReconciliation[] = results.map((r, i) => ({
    venue: requests[i]?.venueId ?? adapters[i]?.id ?? "unknown",
    orderId: r.orderId,
    confirmation: null,
  }));

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let anyPending = false;
    await Promise.all(
      results.map(async (r, i) => {
        const adapter = adapters[i];
        if (!r.orderId || !adapter?.confirmFill) return; // nothing to reconcile
        if (isFinalized(recon[i].confirmation)) return; // already resolved
        const c = await adapter.confirmFill(r.orderId, requests[i]).catch(() => ({ status: "unknown" as const }));
        recon[i].confirmation = c;
        if (c.status === "pending") anyPending = true;
      })
    );
    if (!anyPending) break;
    if (attempt < ATTEMPTS - 1 && DELAY_MS > 0) await new Promise((res) => setTimeout(res, DELAY_MS));
  }
  return recon;
}

// Fold reconciliation back into the placement results: a leg confirmed "failed" is
// forced to zero fill (so status derivation flips to naked/failed correctly); a leg
// confirmed settled with a concrete count adopts it. Pending/unknown/no-confirm are
// left untouched — placement stands.
export function applyReconciliation(results: OrderResult[], recon: LegReconciliation[], requests: OrderRequest[] = []): OrderResult[] {
  return results.map((r, i) => {
    const c = recon[i]?.confirmation;
    if (!c) return r;
    if (c.status === "failed") {
      return { ...r, ok: false, filledContracts: 0, status: "unfilled", error: r.error ?? "settlement failed on reconciliation" };
    }
    if (c.status === "settled" && typeof c.filledContracts === "number") {
      const requestedSize = requests[i]?.sizeContracts;
      const status = c.filledContracts <= 0 ? "unfilled" : requestedSize != null && c.filledContracts < requestedSize ? "partial" : "filled";
      return { ...r, ok: c.filledContracts > 0, filledContracts: c.filledContracts, status, error: c.filledContracts > 0 ? undefined : r.error };
    }
    return r;
  });
}
