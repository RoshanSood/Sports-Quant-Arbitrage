// Polymarket US live order adapter (docs: api-reference/orders/create-order). Places a
// marketable **FILL_OR_KILL** limit BUY on the central order book: fills fully at ≤ our
// price or is killed — no resting/naked leg. The leg's nativeMarketId is the market slug
// and nativeSide is yes/no (long/Over = YES). Credentials (Key ID + Ed25519 secret) are
// per-request from the UI or server env; the gate (agent Live toggle + kill switch + UI
// stake cap + admin auth) decides whether it fires.
//
// NOTE: validate against a $1 live order before trusting it — the exact create-order enum
// values + Ed25519 signing are per the published docs but unverified without a live key.

import type { PolymarketCreds } from "./onchainCreds";
import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";
import { hasPmusCreds, pmusBuyingPower, pmusCreds, pmusFetch } from "./polymarketUsAuth";
import { fetchPolymarketUsSideQuote } from "@/lib/polymarketUs";
import type { PolymarketFillQuote } from "./polymarketAdapter";

const TICK = 0.005; // orderPriceMinTickSize observed on MLB markets

function toTickPrice(cents: number): string {
  const p = Math.round(cents / 100 / TICK) * TICK;
  return Math.min(0.995, Math.max(0.005, p)).toFixed(3);
}

// Live ask-depth quote for the EXACT market slug + side the US order will hit. Returns the
// intl-shaped PolymarketFillQuote so the executor's resize/retry logic is region-agnostic.
// Null when the side has no ask at/under our max price (treated as unfillable).
export async function quotePolymarketUsFokBuy(
  req: OrderRequest,
  _creds?: PolymarketCreds,
  maxPriceCents: number = req.limitPriceCents
): Promise<PolymarketFillQuote | null> {
  const slug = req.nativeMarketId;
  const side = (req.nativeSide ?? "").toLowerCase();
  if (!slug || (side !== "yes" && side !== "no")) return null;
  const q = await fetchPolymarketUsSideQuote(slug, side);
  if (!q || q.availableContracts <= 0 || q.askCents > maxPriceCents + 1e-9) return null;
  return {
    limitPriceCents: q.askCents,
    avgPriceCents: q.askCents,
    availableContracts: q.availableContracts,
    availableStakeUsd: (q.askCents / 100) * q.availableContracts,
  };
}

type CreateOrderResponse = {
  id?: string;
  executions?: Array<{ lastShares?: string; lastPx?: { value?: string }; type?: string }>;
};

export class PolymarketUsExecutionAdapter implements ExecutionAdapter {
  id = "polymarket";
  constructor(private creds?: PolymarketCreds) {}

  supportsLive(): boolean {
    return hasPmusCreds(this.creds);
  }

  async getBalanceUsd(): Promise<number | null> {
    const c = pmusCreds(this.creds);
    if (!c) return null;
    return (await pmusBuyingPower(c)).buyingPower;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const creds = pmusCreds(this.creds);
    if (!creds) return reject(req, "Polymarket US credentials not configured");

    const marketSlug = req.nativeMarketId;
    const side = (req.nativeSide ?? "").toLowerCase();
    if (!marketSlug || (side !== "yes" && side !== "no")) {
      return reject(req, "missing Polymarket US market slug / yes-no side — live order not wired for this leg");
    }

    // Guarantee the $1 marketable-BUY floor at the point of order — a sub-$1 FOK is
    // rejected by Polymarket, so fail with a clear reason instead of a cryptic venue error.
    const notionalUsd = req.sizeContracts * (req.limitPriceCents / 100);
    if (notionalUsd < 1) {
      return reject(req, `order notional $${notionalUsd.toFixed(2)} below Polymarket $1 minimum marketable buy`);
    }

    const body = {
      marketSlug,
      type: "ORDER_TYPE_LIMIT",
      outcomeSide: side === "yes" ? "OUTCOME_SIDE_YES" : "OUTCOME_SIDE_NO",
      action: "ORDER_ACTION_BUY",
      price: { value: toTickPrice(req.limitPriceCents), currency: "USD" },
      quantity: String(req.sizeContracts),
      tif: "FILL_OR_KILL",
      synchronousExecution: true, // block until fill/kill so the result is final
    };

    const r = await pmusFetch<CreateOrderResponse>("POST", "/v1/orders", creds, body);
    if (!r.ok || !r.data) return reject(req, r.error ?? `order rejected (HTTP ${r.status})`, { status: r.status, body: r.data ?? r.error });

    const execs = r.data.executions ?? [];
    const filled = execs.reduce((s, e) => s + (Number(e.lastShares) || 0), 0);
    const ok = filled > 0;
    // Volume-weighted avg fill price (cents), falling back to our limit.
    const notional = execs.reduce((s, e) => s + (Number(e.lastShares) || 0) * (Number(e.lastPx?.value) || 0), 0);
    const avgCents = filled > 0 && notional > 0 ? Math.round((notional / filled) * 100) : req.limitPriceCents;

    return {
      ok,
      orderId: r.data.id ?? null,
      filledContracts: Math.round(filled),
      avgPriceCents: avgCents,
      status: filled >= req.sizeContracts ? "filled" : filled > 0 ? "partial" : "unfilled",
      error: ok ? undefined : "FOK order not filled",
      raw: r.data,
    };
  }

  // Confirm settlement by re-reading the order (FOK is atomic, so this mostly re-affirms).
  async confirmFill(orderId: string, _req: OrderRequest): Promise<FillConfirmation> {
    void _req;
    const creds = pmusCreds(this.creds);
    if (!creds) return { status: "unknown" };
    const r = await pmusFetch<CreateOrderResponse>("GET", `/v1/orders/${orderId}`, creds);
    if (!r.ok || !r.data) return { status: "unknown" };
    const filled = (r.data.executions ?? []).reduce((s, e) => s + (Number(e.lastShares) || 0), 0);
    if (filled > 0) return { status: "settled", filledContracts: Math.round(filled) };
    return { status: "failed", filledContracts: 0 };
  }
}

function reject(req: OrderRequest, error: string, raw?: unknown): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error, raw };
}
