// SX.bet real-time order book via Centrifugo (SX migrated off Ably — deprecated 2026-07-01).
// Built from SX's documented Centrifugo API (https://docs.sx.bet/api-reference/centrifugo-*)
// — NOT live-verified (no test API key available in this environment). Every parsing step
// is defensive: if a message doesn't match the documented shape it is simply dropped, never
// surfaced as a wrong price — ingest.ts falls back to REST until this is proven live. Verify
// by running the app with SX_API_KEY configured and watching for "[sxbetLiveBook]" logs.
//
// Docs: wss://realtime.sx.bet/connection/websocket, connection token from
// GET https://api.sx.bet/user/realtime-token/api-key (header x-api-key). Channel per market:
// "order_book:market_{marketHash}", publications are arrays of order objects — the SAME
// shape (marketHash, percentageOdds, totalBetSize, fillAmount, isMakerBettingOutcomeOne,
// status) as this codebase's existing REST order-book reader (sxbet.ts's SxOrder/bestPrices),
// so we reuse that odds math instead of re-deriving SX's unusual encoding a second time.

import { Centrifuge } from "centrifuge";
import WS from "ws";

export type LiveQuote = { o1AskCents: number | null; o2AskCents: number | null; updatedAt: number };

const WS_URL = process.env.SX_WS_URL ?? "wss://realtime.sx.bet/connection/websocket";
const TOKEN_URL = (process.env.SX_API_BASE ?? "https://api.sx.bet") + "/user/realtime-token/api-key";

type RawOrder = {
  marketHash?: string;
  orderHash?: string;
  status?: string; // "ACTIVE" | "INACTIVE" | "FILLED"
  percentageOdds?: string;
  totalBetSize?: string;
  fillAmount?: string;
  isMakerBettingOutcomeOne?: boolean;
};

// Reproduces sxbet.ts's bestPrices() math (not exported there) — same fields, same
// percentageOdds convention (scaled 1e20; a maker betting outcome ONE sets the taker's
// outcome-TWO price, and vice versa), same 1 - p -> cents conversion.
function bestAsksFromOrders(orders: Map<string, RawOrder>): { o1AskCents: number | null; o2AskCents: number | null } {
  let bestPforO1 = 0;
  let bestPforO2 = 0;
  for (const o of orders.values()) {
    if (o.status !== "ACTIVE") continue;
    const avail = Number(o.totalBetSize) - Number(o.fillAmount);
    if (!(avail > 0)) continue;
    const p = Number(o.percentageOdds) / 1e20;
    if (!(p > 0) || p >= 1) continue;
    if (!o.isMakerBettingOutcomeOne) {
      if (p > bestPforO1) bestPforO1 = p;
    } else if (p > bestPforO2) {
      bestPforO2 = p;
    }
  }
  return {
    o1AskCents: bestPforO1 > 0 ? Number(((1 - bestPforO1) * 100).toFixed(4)) : null,
    o2AskCents: bestPforO2 > 0 ? Number(((1 - bestPforO2) * 100).toFixed(4)) : null,
  };
}

export const LIVE_QUOTE_STALE_MS = 15_000;

async function fetchToken(apiKey: string): Promise<string> {
  const res = await fetch(TOKEN_URL, { headers: { "x-api-key": apiKey }, cache: "no-store" });
  if (!res.ok) throw new Error(`SX realtime token fetch failed: ${res.status}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("SX realtime token response missing token");
  return data.token;
}

export class SxBetLiveBook {
  private client: Centrifuge | null = null;
  private subs = new Map<string, ReturnType<Centrifuge["newSubscription"]>>();
  private orders = new Map<string, Map<string, RawOrder>>(); // marketHash -> orderHash -> order
  private quotes = new Map<string, LiveQuote>();
  private apiKey: string | null = null;

  connect(apiKeyOverride?: string): void {
    const apiKey = apiKeyOverride ?? process.env.SX_API_KEY;
    if (!apiKey || this.client) return;
    this.apiKey = apiKey;
    this.client = new Centrifuge(WS_URL, {
      getToken: () => fetchToken(apiKey),
      websocket: WS,
    });
    this.client.on("error", (ctx) => console.error("[sxbetLiveBook] client error:", ctx));
    this.client.connect();
  }

  private handlePublication(marketHash: string, data: unknown): void {
    const updates = Array.isArray(data) ? (data as RawOrder[]) : [data as RawOrder];
    let book = this.orders.get(marketHash);
    if (!book) {
      book = new Map();
      this.orders.set(marketHash, book);
    }
    for (const o of updates) {
      if (!o?.orderHash) continue;
      if (o.status === "ACTIVE") book.set(o.orderHash, o);
      else book.delete(o.orderHash); // INACTIVE (cancelled) / FILLED — no longer available
    }
    const { o1AskCents, o2AskCents } = bestAsksFromOrders(book);
    this.quotes.set(marketHash, { o1AskCents, o2AskCents, updatedAt: Date.now() });
  }

  // Update the set of markets we track (today's SX.bet MLB market hashes, refreshed each
  // REST ingest pass). Subscriptions not in the new set are unsubscribed; new ones added.
  setMarkets(marketHashes: string[]): void {
    try {
      if (!this.client) this.connect();
    } catch (error) {
      console.error("[sxbetLiveBook] connect failed; continuing with REST books:", error);
      return;
    }
    if (!this.client) return; // no API key configured — stays inert
    const next = new Set(marketHashes.filter(Boolean));
    for (const [hash, sub] of this.subs) {
      if (!next.has(hash)) {
        // unsubscribe() leaves the channel in Centrifuge's internal registry.
        // removeSubscription() is required before a later A -> B -> A resubscribe.
        try {
          this.client.removeSubscription(sub);
        } catch (error) {
          console.error(`[sxbetLiveBook] failed to remove subscription ${hash}:`, error);
        }
        this.subs.delete(hash);
        this.orders.delete(hash);
        this.quotes.delete(hash);
      }
    }
    for (const hash of next) {
      if (this.subs.has(hash)) continue;
      const channel = `order_book:market_${hash}`;
      try {
        // Heal a registry/map mismatch left by HMR or an earlier partial failure.
        const orphan = this.client.getSubscription(channel);
        if (orphan) this.client.removeSubscription(orphan);
        const sub = this.client.newSubscription(channel, { positioned: true, recoverable: true });
        sub.on("publication", (ctx) => this.handlePublication(hash, ctx.data));
        sub.on("error", (ctx) => console.error(`[sxbetLiveBook] subscription error ${hash}:`, ctx));
        sub.subscribe();
        this.subs.set(hash, sub);
      } catch (error) {
        // Live sockets only accelerate freshness. Keep REST-backed scanning alive when
        // an individual channel cannot be managed.
        console.error(`[sxbetLiveBook] failed to subscribe ${hash}; using REST books:`, error);
      }
    }
  }

  getQuote(marketHash: string): LiveQuote | null {
    const q = this.quotes.get(marketHash);
    if (!q) return null;
    if (Date.now() - q.updatedAt > LIVE_QUOTE_STALE_MS) return null;
    return q;
  }

  status(): { connected: boolean; subscribedCount: number; quoteCount: number } {
    return { connected: this.client?.state === "connected", subscribedCount: this.subs.size, quoteCount: this.quotes.size };
  }

  close(): void {
    for (const [hash, sub] of this.subs) {
      try {
        this.client?.removeSubscription(sub);
      } catch (error) {
        console.error(`[sxbetLiveBook] failed to remove subscription ${hash} during close:`, error);
      }
    }
    this.subs.clear();
    this.orders.clear();
    this.quotes.clear();
    this.client?.disconnect();
    this.client = null;
    this.apiKey = null;
  }
}

export const sxbetLiveBook = new SxBetLiveBook();

// Exported for testing — pure, no I/O.
export { bestAsksFromOrders };
