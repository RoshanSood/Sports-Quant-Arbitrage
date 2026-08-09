// Kalshi websocket (trade-api/ws/v2, orderbook_delta channel) — a persistent, real-time
// replacement for polling REST for Kalshi's best yes/no ask.
//
// Live-verified 2026-08-09 against the real feed with real credentials (auth handshake,
// subscribe ack, snapshot, and delta all observed). The auth/signing and the delta shape
// (price_dollars/delta_fp/side) matched Kalshi's docs, but the SNAPSHOT shape did not: real
// snapshots carry the levels under `yes_dollars_fp`/`no_dollars_fp` (not `yes`/`no`), as
// [priceDollarsString, qtyString] pairs (not numeric [cents, qty] tuples) — e.g.
// ["0.0100", "141011.00"]. The documented-but-wrong shape meant applySnapshot() silently
// returned null for every snapshot, so no book was ever initialized and every delta was
// dropped too (handleEnvelope requires an existing book to apply a delta to) — the feed was
// inert, never wrong, exactly as this file's parsing was designed to fail safe. Fixed below.
//
// Every WS connection is authenticated during the HTTP upgrade — even for market data — by
// signing method "GET" + path "/trade-api/ws/v2" the same way as a REST GET (reuses
// kalshiAuth.ts's authHeaders). The standard WebSocket API has no way to send custom
// handshake headers, so this uses the `ws` package instead of the native global WebSocket
// (which sufficed for Polymarket's unauthenticated feed).
//
// Kalshi's book is two SIDES of resting BIDS (yes bids, no bids) — there is no separate ask
// array. The ask to BUY yes = 100 - (highest resting NO bid); the ask to buy NO = 100 -
// (highest resting YES bid) — the same complement relationship this codebase's REST path
// already uses (kalshi.ts: noAskCents = Math.round((1 - yesBid) * 100)). A delta only touches
// one price level, so (unlike Polymarket's feed, which hands us a precomputed best price) we
// maintain the actual per-price-level book here and recompute the best bid on read.

import WS from "ws";
import { authHeaders, isKalshiConfigured, type KalshiCreds } from "@/lib/kalshiAuth";

export type LiveQuote = { yesAskCents: number | null; noAskCents: number | null; updatedAt: number };

const WS_PATH = "/trade-api/ws/v2";
const WS_URL = (process.env.KALSHI_WS_URL ?? "wss://api.elections.kalshi.com") + WS_PATH;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
export const LIVE_QUOTE_STALE_MS = 15_000;

type Envelope = { type?: string; sid?: number; seq?: number; msg?: unknown };
// Real shape (verified live): levels are [priceDollarsString, qtyString] pairs, e.g. ["0.0100", "141011.00"].
type SnapshotMsg = { market_ticker?: string; yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][] };
type DeltaMsg = { market_ticker?: string; price_dollars?: string; delta_fp?: string; side?: "yes" | "no" };

function bestBid(levels: Map<number, number>): number | null {
  let best: number | null = null;
  for (const [price, qty] of levels) {
    if (qty > 0 && (best == null || price > best)) best = price;
  }
  return best;
}

// Pure reducer: apply a snapshot, returning fresh yes/no level maps (price cents -> qty).
// Levels arrive as [priceDollarsString, qtyString] pairs — parse and convert to cents,
// same as applyDelta below.
export function applySnapshot(msg: SnapshotMsg): { yes: Map<number, number>; no: Map<number, number> } | null {
  if (!msg.market_ticker || !Array.isArray(msg.yes_dollars_fp) || !Array.isArray(msg.no_dollars_fp)) return null;
  const toMap = (levels: [string, string][]) => {
    const map = new Map<number, number>();
    for (const [priceStr, qtyStr] of levels) {
      const price = Math.round(Number(priceStr) * 100);
      const qty = Number(qtyStr);
      if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) map.set(price, qty);
    }
    return map;
  };
  return { yes: toMap(msg.yes_dollars_fp), no: toMap(msg.no_dollars_fp) };
}

// Pure reducer: apply one delta to an existing level map (mutates a COPY, returns it).
export function applyDelta(levels: Map<number, number>, msg: DeltaMsg): Map<number, number> {
  const price = Math.round(Number(msg.price_dollars) * 100);
  const delta = Number(msg.delta_fp);
  if (!Number.isFinite(price) || !Number.isFinite(delta)) return levels;
  const next = new Map(levels);
  const nextQty = (next.get(price) ?? 0) + delta;
  if (nextQty <= 0) next.delete(price);
  else next.set(price, nextQty);
  return next;
}

// A gap of exactly 1 missing seq number is tolerated, not treated as real loss. Live-verified
// 2026-08-09: issuing a "subscribe" command burns ~1 seq number in Kalshi's own accounting
// even when zero tickers are actually new (re-subscribing the SAME 5 tickers: seq +1) — and
// that consumption is never itself forwarded as a visible message. setTickers() below now
// only subscribes newly-added tickers, but the scan loop still calls it roughly every ~1s as
// the ticker catalog naturally drifts, so this +1 artifact recurs constantly on a live,
// multi-ticker connection — any unrelated real delta landing between our reset and that
// silent consumption makes it look like a dropped message relative to whatever we saw last.
// A genuine dropped packet, by contrast, would very likely lose more than one message in a
// burst. Recovering (clearing every tracked book, forcing 80+ fresh snapshots) on every
// single-missing-number blip was constant self-inflicted churn for zero real benefit.
const TOLERATED_MISSING_SEQ = 1;

// Pure: does `seq` indicate a genuine (worth recovering from) gap since `prevSeq`? Both must
// come from the SAME connection's single global counter — never compare one ticker's seq
// against another ticker's (that was the ORIGINAL bug: it looked like a gap on nearly every
// message once >1 ticker was subscribed, because unrelated tickers' messages land in
// between). null prevSeq means "first message seen this connection" — nothing to compare
// yet, never a gap.
export function isSequenceGap(prevSeq: number | null, seq: number | null): boolean {
  if (prevSeq == null || seq == null) return false;
  return seq - prevSeq - 1 > TOLERATED_MISSING_SEQ;
}

// Pure: total contracts available to BUY a side at or better than limitPriceCents. Kalshi's
// book only holds resting BIDS (yes bids, no bids) — buying yes fills against no bids (yes
// ask = 100 - no bid price, same complement used by updateQuote below), so depth for buying
// `side` comes from the OPPOSITE side's bid levels whose complement price clears the limit.
export function depthAtOrBetter(oppositeSideBids: Map<number, number>, limitPriceCents: number): number {
  const minBidPrice = 100 - limitPriceCents;
  let total = 0;
  for (const [price, qty] of oppositeSideBids) {
    if (price >= minBidPrice) total += qty;
  }
  return total;
}

class KalshiLiveBook {
  private ws: WS | null = null;
  private books = new Map<string, { yes: Map<number, number>; no: Map<number, number> }>();
  private quotes = new Map<string, LiveQuote>();
  private subscribed: string[] = [];
  // `seq` is ONE counter for the whole subscription, not per-ticker — confirmed live: the
  // initial snapshot burst for 5 subscribed tickers arrived as seq 1,2,3,4,5 in a single
  // stream (one sid). Tracking it per-ticker (the original bug) compared ticker T's Nth
  // message against the GLOBAL seq of T's (N-1)th message — with 80+ tickers subscribed,
  // dozens of other tickers' messages land in between, so it looked like a "gap" on nearly
  // every single message and triggered a near-continuous resubscribe storm (caught live
  // 2026-08-09 from a wall of "[kalshiLiveBook] sequence gap ... resubscribing" logs).
  private lastSeq: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private closing = false;
  private creds?: KalshiCreds;

  connect(creds?: KalshiCreds): void {
    if (this.ws || this.closing) return;
    if (!isKalshiConfigured(creds)) return; // no key — nothing to connect with
    this.creds = creds;
    this.closing = false;
    this.openSocket();
  }

  private openSocket(): void {
    const headers = authHeaders("GET", WS_PATH, this.creds);
    if (!headers["KALSHI-ACCESS-KEY"]) return; // signing failed (no key/pem) — stay inert
    let ws: WS;
    try {
      ws = new WS(WS_URL, { headers });
    } catch (e) {
      console.error("[kalshiLiveBook] failed to construct WebSocket:", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.sendSubscribe();
    });

    ws.on("message", (data: WS.RawData) => {
      try {
        this.handleEnvelope(JSON.parse(data.toString()));
      } catch (e) {
        console.error("[kalshiLiveBook] failed to parse message:", e);
      }
    });

    ws.on("close", () => {
      this.ws = null;
      if (!this.closing) this.scheduleReconnect();
    });

    ws.on("error", (e: Error) => {
      console.error("[kalshiLiveBook] socket error:", e.message);
    });
  }

  private handleEnvelope(env: Envelope): void {
    if (env.type !== "orderbook_snapshot" && env.type !== "orderbook_delta") return;

    // Connection-wide sequence check (see lastSeq's doc comment) — applies to snapshot AND
    // delta messages alike, since both carry the same shared counter.
    if (env.seq != null) {
      if (isSequenceGap(this.lastSeq, env.seq)) {
        // A REAL gap: the connection dropped a message and we don't know which ticker(s) it
        // touched, so every book is now suspect. Resubscribing gets fresh snapshots for
        // everything (Kalshi does not replay missed deltas).
        console.warn(`[kalshiLiveBook] sequence gap (${this.lastSeq} -> ${env.seq}), resubscribing to recover`);
        this.books.clear();
        this.quotes.clear();
        this.sendSubscribe();
        return;
      }
      this.lastSeq = env.seq;
    }

    if (env.type === "orderbook_snapshot") {
      const parsed = applySnapshot(env.msg as SnapshotMsg);
      const ticker = (env.msg as SnapshotMsg)?.market_ticker;
      if (parsed && ticker) {
        this.books.set(ticker, parsed);
        this.updateQuote(ticker);
      }
    } else {
      const msg = env.msg as DeltaMsg;
      const ticker = msg?.market_ticker;
      if (!ticker) return;
      const book = this.books.get(ticker);
      // A delta before we've seen a snapshot for this ticker can't be applied correctly —
      // ignore it and wait for the snapshot our subscribe request already triggered.
      if (!book) return;
      const side = msg.side === "no" ? "no" : msg.side === "yes" ? "yes" : null;
      if (!side) return;
      book[side] = applyDelta(book[side], msg);
      this.updateQuote(ticker);
    }
  }

  private updateQuote(ticker: string): void {
    const book = this.books.get(ticker);
    if (!book) return;
    const bestNoBid = bestBid(book.no);
    const bestYesBid = bestBid(book.yes);
    this.quotes.set(ticker, {
      yesAskCents: bestNoBid != null ? 100 - bestNoBid : null,
      noAskCents: bestYesBid != null ? 100 - bestYesBid : null,
      updatedAt: Date.now(),
    });
  }

  // `tickers` defaults to the full current set (initial connect / gap-recovery, where we
  // need everything fresh). setTickers() below passes just the newly-added subset instead —
  // live-verified 2026-08-09: Kalshi's "subscribe" is ADDITIVE (re-subscribing to an already-
  // subscribed ticker does NOT resend its snapshot, and already-flowing tickers' deltas are
  // completely unaffected), but issuing the command AT ALL costs exactly 2 seq numbers in
  // Kalshi's own accounting regardless of how many tickers are actually new. Sending the
  // FULL list on every change (the original bug) meant nearly every ~1s scan tick burned 2
  // seq numbers for zero new data, tripping the gap-recovery path on a self-inflicted,
  // entirely harmless discontinuity — seen live as constant "sequence gap ... resubscribing"
  // spam. Only subscribing the diff cuts that down to real ticker additions.
  private sendSubscribe(tickers: string[] = this.subscribed): void {
    if (!this.ws || this.ws.readyState !== WS.OPEN || tickers.length === 0) return;
    // ANY subscribe call (even this narrower one) causes the known +2 seq jump above — reset
    // our baseline so that expected, harmless jump is never mistaken for a real dropped
    // message on the NEXT delta we see for an unrelated, already-subscribed ticker.
    this.lastSeq = null;
    this.ws.send(JSON.stringify({ id: Date.now(), cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: tickers } }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
      this.openSocket();
    }, this.reconnectDelayMs);
  }

  // Update the set of tickers we track (today's Kalshi MLB market tickers, refreshed by each
  // REST ingest pass — same discovery-via-REST, freshness-via-socket split as Polymarket).
  setTickers(tickers: string[]): void {
    const next = [...new Set(tickers.filter(Boolean))].sort();
    const prev = this.subscribed;
    if (next.length === prev.length && next.every((t, i) => t === prev[i])) return;
    const prevSet = new Set(prev);
    const added = next.filter((t) => !prevSet.has(t));
    this.subscribed = next;
    const nextSet = new Set(next);
    for (const k of [...this.books.keys()]) if (!nextSet.has(k)) { this.books.delete(k); this.quotes.delete(k); }
    if (this.ws?.readyState === WS.OPEN) {
      // Only subscribe the NEW tickers — see sendSubscribe's doc comment. Tickers that
      // dropped out of `next` were already deleted above; Kalshi keeps streaming their
      // deltas (there's no per-ticker unsubscribe), but with no local book to apply them to
      // they're cheaply ignored (handleEnvelope's `if (!book) return`).
      if (added.length) this.sendSubscribe(added);
    } else if (isKalshiConfigured(this.creds)) this.connect(this.creds);
  }

  getQuote(ticker: string): LiveQuote | null {
    const q = this.quotes.get(ticker);
    if (!q) return null;
    if (Date.now() - q.updatedAt > LIVE_QUOTE_STALE_MS) return null;
    return q;
  }

  // Contracts available to buy `side` at or better than limitPriceCents, or null if we have
  // no book / it's gone stale for this ticker (unknown, not zero — caller should not treat
  // null as "no liquidity").
  getDepth(ticker: string, side: "yes" | "no", limitPriceCents: number): number | null {
    const book = this.books.get(ticker);
    const q = this.quotes.get(ticker);
    if (!book || !q || Date.now() - q.updatedAt > LIVE_QUOTE_STALE_MS) return null;
    return depthAtOrBetter(side === "yes" ? book.no : book.yes, limitPriceCents);
  }

  status(): { connected: boolean; subscribedCount: number; quoteCount: number } {
    return { connected: this.ws?.readyState === WS.OPEN, subscribedCount: this.subscribed.length, quoteCount: this.quotes.size };
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

export const kalshiLiveBook = new KalshiLiveBook();
