// Cloudbet live order (bet) adapter. Cloudbet is a crypto SPORTSBOOK, not an exchange: a
// bet is a stake at decimal odds, all-or-nothing, and cannot be cancelled once matched.
// We post a marketable BACK bet to POST /pub/v3/bets/place with the X-API-Key, mapping our
// contract/limit model onto Cloudbet's stake/odds model:
//   • decimal limit odds  = 100 / limitPriceCents               (min odds we'll accept)
//   • stake (currency)     = USD cost at the limit / USD value per currency unit
//   • acceptPriceChange    = BETTER  → fill only at that price or better (limit semantics)
// Contracts filled ($1-payout units) = stake * acceptedOdds * USD value. Credentials: an API key
// (CLOUDBET_API_KEY) + the settlement currency (CLOUDBET_CURRENCY, default USDC). The key
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

// The arb engine sizes every leg in USD. Stablecoins map one-for-one; volatile/native
// Cloudbet currencies require an explicit USD rate before live betting can be enabled.
// This prevents (for example) treating a 1 SOL stake as $1.
export function cbUsdPerCurrencyUnit(currency: string): number | null {
  const code = currency.trim().toUpperCase();
  if (["USD", "USDC", "USDT", "USDP", "DAI"].includes(code)) return 1;
  const raw = process.env[`CLOUDBET_${code}_USD_RATE`]?.trim() || process.env.CLOUDBET_CURRENCY_USD_RATE?.trim();
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
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
    return Boolean(cbApiKey(this.creds) && cbUsdPerCurrencyUnit(cbCurrency(this.creds)));
  }

  async getBalanceUsd(): Promise<number | null> {
    const key = cbApiKey(this.creds);
    if (!key) return null;
    const currency = cbCurrency(this.creds);
    const rate = cbUsdPerCurrencyUnit(currency);
    if (rate == null) return null;
    const nativeBalance = await cbBalance(key, currency);
    return nativeBalance == null ? null : nativeBalance * rate;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const apiKey = cbApiKey(this.creds);
    if (!apiKey) return reject(req, "Cloudbet API key not configured");
    const currency = cbCurrency(this.creds);
    const usdPerCurrencyUnit = cbUsdPerCurrencyUnit(currency);
    if (usdPerCurrencyUnit == null) {
      return reject(req, `Cloudbet live sizing needs CLOUDBET_${currency.toUpperCase()}_USD_RATE`);
    }
    const eventId = req.nativeMarketId;
    const marketUrl = req.nativeSide; // e.g. "baseball.moneyline/home"
    if (!eventId || !marketUrl) return reject(req, "missing Cloudbet event/market — live bet not wired for this leg");
    if (req.limitPriceCents <= 0 || req.limitPriceCents >= 100) return reject(req, "invalid Cloudbet limit price");

    const decimalLimit = 100 / req.limitPriceCents; // min odds we'll accept
    const stakeUsd = (req.sizeContracts * req.limitPriceCents) / 100;
    const stake = stakeUsd / usdPerCurrencyUnit;
    const referenceId = crypto.randomUUID();
    const body = {
      referenceId,
      currency,
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

      // PENDING_ACCEPTANCE → the engine is still processing; poll the status endpoint.
      for (let i = 0; status === "PENDING_ACCEPTANCE" && i < 4; i++) {
        await sleep(600);
        const s = await this.betStatus(apiKey, referenceId);
        if (s?.status) status = s.status.toUpperCase();
        if (s?.price) b.price = s.price;
      }

      if (!res.ok || !PLACED_STATUSES.has(status)) {
        return reject(req, b.error || status || `bet rejected (HTTP ${res.status})`);
      }

      const acceptedOdds = Number(b.price) || decimalLimit;
      const filledContracts = Math.max(1, Math.round(stake * acceptedOdds * usdPerCurrencyUnit));
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
      const rate = cbUsdPerCurrencyUnit(cbCurrency(this.creds));
      if (rate == null) return { status: "unknown" };
      const stake = ((req.sizeContracts * req.limitPriceCents) / 100) / rate;
      return { status: "settled", filledContracts: Math.max(1, Math.round(stake * odds * rate)) };
    }
    if (status === "PENDING_ACCEPTANCE") return { status: "pending" };
    return { status: "failed", filledContracts: 0 };
  }

  private async betStatus(apiKey: string, referenceId: string): Promise<CbBetResponse | null> {
    try {
      const r = await fetch(`${API}/pub/v3/bets/${referenceId}/status`, {
        method: "POST",
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
