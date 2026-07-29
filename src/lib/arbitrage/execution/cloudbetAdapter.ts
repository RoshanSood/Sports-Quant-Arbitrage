// CloudBet live order (bet) adapter. CloudBet is a crypto SPORTSBOOK, not an exchange: a
// bet is a stake at decimal odds, all-or-nothing, and cannot be cancelled once matched.
// We post a marketable BACK bet to POST /pub/v3/bets/place with the X-API-Key, mapping our
// contract/limit model onto CloudBet's stake/odds model:
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
const FEED = "https://sports-api.cloudbet.com/pub/v2/odds";

// During a LIVE event Cloudbet suspends the full-game market between plays
// (SELECTION_DISABLED, price 0) and only re-opens it in brief windows. A place request
// that lands on a suspended market is rejected, which is why live legs never fill. To
// place a live bet we must catch an enabled window: poll the single-event feed for our
// outcome and return the first fresh enabled price. Pre-match markets are enabled
// continuously, so this returns on the first poll (adds ~1 request, no real latency).
// Returns null if the market never re-opens within timeoutMs.
type CbFeedSel = { outcome?: string; params?: string; price?: number; status?: string; minStake?: number };
export async function cbLiveEnabledPrice(
  apiKey: string,
  eventId: string,
  marketUrl: string,
  timeoutMs = 8000
): Promise<{ price: number; minStake: number } | null> {
  const base = marketUrl.split("?")[0]; // strip grouping params
  const marketKey = base.split("/")[0]; // e.g. baseball.moneyline
  const outcome = base.split("/")[1]; // home | away | draw
  const expectedParams = new URLSearchParams(marketUrl.includes("?") ? marketUrl.split("?")[1] : "");
  if (!marketKey || !outcome) return null;
  const deadline = Date.now() + timeoutMs;
  const url = `${FEED}/events/${encodeURIComponent(eventId)}?markets=${encodeURIComponent(marketKey)}`;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { headers: { "X-API-Key": apiKey, Accept: "application/json" }, cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { markets?: Record<string, { submarkets?: Record<string, { selections?: CbFeedSel[] }> }> };
        const subs = j.markets?.[marketKey]?.submarkets ?? {};
        for (const sub of Object.values(subs)) {
          const sel = (sub.selections ?? []).find((s) => s.outcome === outcome && paramsMatch(s, expectedParams));
          if (sel && (!sel.status || sel.status === "SELECTION_ENABLED") && typeof sel.price === "number" && sel.price > 1) {
            return { price: sel.price, minStake: typeof sel.minStake === "number" ? sel.minStake : 0 };
          }
        }
      }
    } catch {
      // transient — keep polling until the deadline
    }
    if (Date.now() < deadline) await sleep(400);
  }
  return null;
}

function paramsMatch(sel: CbFeedSel, expected: URLSearchParams): boolean {
  for (const [key, value] of expected.entries()) {
    const actual = new URLSearchParams(sel.params ?? "").get(key);
    if (actual !== value) return false;
  }
  return true;
}

// Creds come from the browser (per-request) or server env.
export function cbApiKey(c?: CloudbetCreds): string | undefined {
  return c?.apiKey?.trim() || process.env.CLOUDBET_API_KEY?.trim() || undefined;
}
export function cbCurrency(c?: CloudbetCreds): string {
  // Default to USDC (most CloudBet crypto balances); override per-request or via
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
// handled separately (poll before deciding).
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
    if (!apiKey) return reject(req, "CloudBet API key not configured");
    const eventId = req.nativeMarketId;
    const marketUrl = req.nativeSide; // e.g. "baseball.moneyline/home"
    if (!eventId || !marketUrl) return reject(req, "missing CloudBet event/market — live bet not wired for this leg");
    if (req.limitPriceCents <= 0 || req.limitPriceCents >= 100) return reject(req, "invalid CloudBet limit price");

    const decimalLimit = 100 / req.limitPriceCents; // min odds we'll accept
    const stake = (req.sizeContracts * req.limitPriceCents) / 100; // cost at the limit, in currency

    // Chase an enabled price window. On a pre-match market this returns immediately; on a
    // LIVE market that is suspended between plays it polls until the market re-opens (or
    // times out). Without this, live legs almost always hit a suspended market and reject.
    const live = await cbLiveEnabledPrice(apiKey, String(eventId), marketUrl, 8000);
    if (!live) return reject(req, "CloudBet market suspended (live) — no enabled price in 8s; will retry next scan");
    if (live.price < decimalLimit) {
      return reject(req, `CloudBet live price ${live.price.toFixed(2)} worse than limit ${decimalLimit.toFixed(2)} — arb no longer holds`);
    }
    if (live.minStake > 0 && stake < live.minStake) {
      return reject(req, `CloudBet stake ${stake.toFixed(4)} below live minStake ${live.minStake}`);
    }

    const referenceId = crypto.randomUUID();
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
      let status = (b.status ?? "").toUpperCase();

      // PENDING_ACCEPTANCE → Cloudbet applies a live-bet acceptance delay while it
      // re-checks the price; this can take several seconds and may resolve to
      // MARKET_SUSPENDED if the market suspends mid-acceptance. Poll up to ~12s.
      for (let i = 0; status === "PENDING_ACCEPTANCE" && i < 12; i++) {
        await sleep(1000);
        const s = await this.betStatus(apiKey, referenceId);
        if (s?.status) status = s.status.toUpperCase();
        if (s?.price) b.price = s.price;
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

  // Re-query the bet to confirm it was accepted (CloudBet grades later; acceptance is the
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

  private async betStatus(apiKey: string, referenceId: string): Promise<CbBetResponse | null> {
    try {
      // GET, not POST — POST /status returns HTTP 405 (this endpoint is read-only).
      const r = await fetch(`${API}/pub/v3/bets/${referenceId}/status`, {
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
      });
      if (!r.ok) return null;
      return (await r.json()) as CbBetResponse;
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
