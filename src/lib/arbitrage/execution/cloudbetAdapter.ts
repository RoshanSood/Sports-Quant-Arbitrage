// Cloudbet live order (bet) adapter. Cloudbet is a crypto SPORTSBOOK, not an exchange: a
// bet is a stake at decimal odds, all-or-nothing, and cannot be cancelled once matched.
// We post a marketable BACK bet to POST /pub/v3/bets/place with the X-API-Key, mapping our
// contract/limit model onto Cloudbet's stake/odds model:
//   • decimal limit odds  = 100 / limitPriceCents               (min odds we'll accept)
//   • stake (currency)     = sizeContracts * limitPriceCents/100 (cost at the limit)
//   • acceptPriceChange    = BETTER  → fill only at that price or better (limit semantics)
// Contracts filled ($1-payout units) = stake * acceptedOdds. Credentials: an API key
// (CLOUDBET_API_KEY) + the settlement currency (CLOUDBET_CURRENCY, default USDT). The key
// is used only to sign the request and is never persisted/logged.
//
// UNVALIDATED — confirm the create-bet response envelope + your currency code with a $1
// live bet before trading. Sportsbook accounts can be limited or refused on winning play.

import crypto from "node:crypto";
import type { CloudbetCreds } from "./onchainCreds";
import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";

const API = "https://sports-api.cloudbet.com";

// Creds come from the browser (per-request) or server env.
export function cbApiKey(c?: CloudbetCreds): string | undefined {
  return c?.apiKey?.trim() || process.env.CLOUDBET_API_KEY?.trim() || undefined;
}
export function cbCurrency(c?: CloudbetCreds): string {
  // Default to USDC (most Cloudbet crypto balances); override per-request or via
  // CLOUDBET_CURRENCY for USDT/BTC/ETH/etc.
  return c?.currency?.trim() || process.env.CLOUDBET_CURRENCY?.trim() || "USDC";
}

// Account balance for a settlement currency (units of that currency; USDC/USDT ≈ USD).
// Returns a discriminated result so callers can tell a rejected key from an unknown
// currency instead of a bare null.
export async function cbBalanceResult(
  apiKey: string,
  currency: string
): Promise<{ ok: true; amount: number } | { ok: false; detail: string }> {
  try {
    const r = await fetch(`${API}/pub/v1/account/currencies/${encodeURIComponent(currency)}/balance`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      cache: "no-store",
    });
    const text = await r.text();
    if (!r.ok) {
      const hint =
        r.status === 401 || r.status === 403
          ? "API key rejected"
          : r.status === 404
            ? `currency ${currency} not held/recognized`
            : `HTTP ${r.status}`;
      return { ok: false, detail: `${hint}${text ? ` — ${text.slice(0, 80)}` : ""}` };
    }
    const n = Number((text ? JSON.parse(text) : {})?.amount);
    return Number.isFinite(n) ? { ok: true, amount: n } : { ok: false, detail: "no amount in response" };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 80) };
  }
}

export async function cbBalance(apiKey: string, currency: string): Promise<number | null> {
  const r = await cbBalanceResult(apiKey, currency);
  return r.ok ? r.amount : null;
}

type CbBetResponse = { status?: string; price?: string; stake?: string; returnAmount?: string; error?: string; referenceId?: string };

// Statuses that mean the bet is live/graded (not a rejection). PENDING_ACCEPTANCE is
// handled separately by shared reconciliation.
const PLACED_STATUSES = new Set(["ACCEPTED", "WIN", "LOSS", "PUSH", "HALF_WIN", "HALF_LOSS", "PARTIAL"]);

export class CloudbetExecutionAdapter implements ExecutionAdapter {
  id = "cloudbet";
  constructor(private creds?: CloudbetCreds) {}

  supportsLive(): boolean {
    return Boolean(cbApiKey(this.creds));
  }

  async getBalanceUsd(): Promise<number | null> {
    const key = cbApiKey(this.creds);
    if (!key) return null;
    return cbBalance(key, cbCurrency(this.creds));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const apiKey = cbApiKey(this.creds);
    if (!apiKey) return reject(req, "Cloudbet API key not configured");
    const eventId = req.nativeMarketId;
    const marketUrl = req.nativeSide; // e.g. "baseball.moneyline/home"
    if (!eventId || !marketUrl) return reject(req, "missing Cloudbet event/market — live bet not wired for this leg");
    if (req.limitPriceCents <= 0 || req.limitPriceCents >= 100) return reject(req, "invalid Cloudbet limit price");

    const decimalLimit = 100 / req.limitPriceCents; // min odds we'll accept
    const stake = (req.sizeContracts * req.limitPriceCents) / 100; // cost at the limit, in currency
    const referenceId = req.clientOrderId ?? crypto.randomUUID();
    const body = {
      referenceId,
      currency: cbCurrency(this.creds),
      eventId: String(eventId),
      marketUrl,
      price: decimalLimit.toFixed(4),
      stake: stake.toFixed(6),
      acceptPriceChange: "BETTER", // accept a higher (better) price; reject a worse one
    };

    try {
      const res = await fetch(`${API}/pub/v3/bets/place`, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let b: CbBetResponse = {};
      try {
        b = text ? JSON.parse(text) : {};
      } catch {
        // non-JSON error body
      }
      const status = (b.status ?? "").toUpperCase();

      // Do not turn a real accepted reference into a false rejection while Cloudbet is
      // still processing it. Return pending immediately; the shared reconciliation loop
      // polls the required GET-by-reference endpoint without adding a second inline wait.
      if (res.ok && status === "PENDING_ACCEPTANCE") {
        return {
          ok: true,
          orderId: referenceId,
          filledContracts: 0,
          avgPriceCents: req.limitPriceCents,
          status: "pending",
          raw: b,
        };
      }

      if (!res.ok || !PLACED_STATUSES.has(status)) {
        return reject(req, b.error || status || `bet rejected (HTTP ${res.status})`);
      }

      const acceptedOdds = Number(b.price) || decimalLimit;
      const filledContracts = Math.max(1, Math.round(stake * acceptedOdds));
      return {
        ok: true,
        orderId: referenceId,
        filledContracts,
        avgPriceCents: Number((100 / acceptedOdds).toFixed(4)),
        status: "filled", // a placed book bet fills its stake in full (no partials)
        raw: b,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }

  // Re-query the bet to confirm it was accepted (Cloudbet grades later; acceptance is the
  // "settled position" signal reconciliation needs).
  async confirmFill(orderId: string, req: OrderRequest): Promise<FillConfirmation> {
    const key = cbApiKey(this.creds);
    if (!key) return { status: "unknown" };
    const s = await this.betStatus(key, orderId);
    const status = (s?.status ?? "").toUpperCase();
    if (PLACED_STATUSES.has(status)) {
      const odds = Number(s?.price) || 100 / req.limitPriceCents;
      const stake = (req.sizeContracts * req.limitPriceCents) / 100;
      return { status: "settled", filledContracts: Math.max(1, Math.round(stake * odds)) };
    }
    if (status === "PENDING_ACCEPTANCE") return { status: "pending" };
    return { status: "failed", filledContracts: 0 };
  }

  async recoverOrder(req: OrderRequest): Promise<OrderResult | null> {
    if (!req.clientOrderId) return null;
    const confirmation = await this.confirmFill(req.clientOrderId, req);
    if (confirmation.status === "unknown") return null;
    const filledContracts = confirmation.filledContracts ?? 0;
    return {
      ok: filledContracts > 0,
      orderId: req.clientOrderId,
      filledContracts,
      avgPriceCents: confirmation.avgPriceCents ?? req.limitPriceCents,
      status: confirmation.status === "settled" ? "filled" : confirmation.status === "pending" ? "pending" : "unfilled",
      error: confirmation.error,
    };
  }

  private async betStatus(apiKey: string, referenceId: string): Promise<CbBetResponse | null> {
    try {
      const r = await fetch(`${API}/pub/v3/bets/${referenceId}/status`, {
        method: "GET",
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
      });
      if (!r.ok) return null;
      return (await r.json()) as CbBetResponse;
    } catch {
      return null;
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
