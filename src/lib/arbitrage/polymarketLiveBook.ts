// Polymarket CLOB market-data websocket: a persistent, real-time replacement for polling
// the Gamma REST API for Polymarket's best bid/ask. Verified live against the real feed
// (wss://ws-subscriptions-clob.polymarket.com/ws/market, public — no auth) before writing
// this: a "book" snapshot arrives once per subscribed asset, then "price_change" events push
// the server's own recomputed best_bid/best_ask on every book change — so we don't need to
// reconstruct full depth ourselves, just track best_bid/best_ask per asset id. Docs:
// https://docs.polymarket.com/api-reference/wss/market
//
// This module owns ONE persistent connection (started once from instrumentation-node.ts, a
// Node-only hook that runs once per server process — see that file) that the whole app reads
// from. Subscribing to either token id of a market streams updates for BOTH complementary
// outcomes, so callers only need to pass one representative token id per market to cover it.

export type LiveQuote = { bestBidCents: number | null; bestAskCents: number | null; updatedAt: number };
export type PriceLevel = { priceCents: number; size: number };
// Full depth ladder — refreshed ONLY by "book" snapshots (price_change events only carry the
// server's recomputed best price, no size, so they can't keep a ladder honest). Kept separate
// from `quote.updatedAt` so a fast-moving best price doesn't make a stale ladder look fresh.
export type LevelBook = { bids: PriceLevel[]; asks: PriceLevel[]; updatedAt: number };
export type LiveBookMarketState = "connecting" | "subscribed_waiting_snapshot" | "ready" | "one_sided" | "stale" | "disconnected";

type RawLevel = { price?: string; size?: string };
type RawBookMsg = { event_type?: string; asset_id?: string; bids?: RawLevel[]; asks?: RawLevel[] };
type RawPriceChangeEntry = {
  asset_id?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL" | string;
  best_bid?: string;
  best_ask?: string;
};
type RawPriceChangeMsg = { event_type?: string; price_changes?: RawPriceChangeEntry[] };

function toCents(price: string | undefined): number | null {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 && n < 1 ? Math.round(n * 10000) / 100 : null;
}

// Best bid = highest resting bid price; best ask = lowest resting ask price. Computed by
// value, NOT by array position — the live feed's level ordering is not a documented
// guarantee, so trusting a "first element" convention would silently break if it changes.
function bestFromLevels(levels: RawLevel[] | undefined, pick: "max" | "min"): number | null {
  if (!levels?.length) return null;
  let best: number | null = null;
  for (const l of levels) {
    const size = Number(l.size);
    if (!(size > 0)) continue;
    const price = toCents(l.price);
    if (price == null) continue;
    if (best == null || (pick === "max" ? price > best : price < best)) best = price;
  }
  return best;
}

// Parse a "book" snapshot message for one asset. Returns null if it isn't a usable book msg.
export function parseBookSnapshot(msg: RawBookMsg, now: number): { assetId: string; quote: LiveQuote } | null {
  if (msg.event_type !== "book" || !msg.asset_id) return null;
  return {
    assetId: msg.asset_id,
    quote: {
      bestBidCents: bestFromLevels(msg.bids, "max"),
      bestAskCents: bestFromLevels(msg.asks, "min"),
      updatedAt: now,
    },
  };
}

function toLevels(levels: RawLevel[] | undefined): PriceLevel[] {
  if (!levels?.length) return [];
  const out: PriceLevel[] = [];
  for (const l of levels) {
    const size = Number(l.size);
    const priceCents = toCents(l.price);
    if (size > 0 && priceCents != null) out.push({ priceCents, size });
  }
  return out;
}

// Parse a "book" snapshot into the full depth ladder for one asset (for liquidity checks —
// "is there enough size at this price", not just "what's the best price").
export function parseBookLevels(msg: RawBookMsg, now: number): { assetId: string; levels: LevelBook } | null {
  if (msg.event_type !== "book" || !msg.asset_id) return null;
  return { assetId: msg.asset_id, levels: { bids: toLevels(msg.bids), asks: toLevels(msg.asks), updatedAt: now } };
}

// Pure: total contracts resting at or better than limitPriceCents on one side of the ladder.
// "Better" means <= limit for asks (cheaper to buy) and >= limit for bids (more to sell into).
export function depthAtOrBetter(levels: PriceLevel[], side: "bid" | "ask", limitPriceCents: number): number {
  let total = 0;
  for (const l of levels) {
    if (side === "ask" ? l.priceCents <= limitPriceCents : l.priceCents >= limitPriceCents) total += l.size;
  }
  return total;
}

// Parse a "price_change" message — it can carry updates for MULTIPLE asset ids (both sides
// of a market) in one message, each already carrying the server's recomputed best_bid/ask.
export function parsePriceChange(msg: RawPriceChangeMsg, now: number): Array<{ assetId: string; quote: LiveQuote }> {
  if (msg.event_type !== "price_change" || !msg.price_changes?.length) return [];
  const out: Array<{ assetId: string; quote: LiveQuote }> = [];
  for (const c of msg.price_changes) {
    if (!c.asset_id) continue;
    const bestBidCents = toCents(c.best_bid);
    const bestAskCents = toCents(c.best_ask);
    if (bestBidCents == null && bestAskCents == null) continue;
    out.push({ assetId: c.asset_id, quote: { bestBidCents, bestAskCents, updatedAt: now } });
  }
  return out;
}

// Polymarket price_change entries carry the NEW aggregate size for a single price level;
// size="0" removes it. Apply them to a copy so readers can capture immutable snapshots
// without observing a ladder halfway through a multi-entry websocket message.
export function applyPriceChanges(
  current: LevelBook,
  changes: RawPriceChangeEntry[],
  assetId: string,
  now: number
): LevelBook {
  const bids = new Map(current.bids.map((level) => [level.priceCents, level.size]));
  const asks = new Map(current.asks.map((level) => [level.priceCents, level.size]));
  for (const change of changes) {
    if (change.asset_id !== assetId) continue;
    const priceCents = toCents(change.price);
    const size = Number(change.size);
    const side = String(change.side ?? "").toUpperCase();
    if (priceCents == null || !Number.isFinite(size) || (side !== "BUY" && side !== "SELL")) continue;
    const levels = side === "BUY" ? bids : asks;
    if (size <= 0) levels.delete(priceCents);
    else levels.set(priceCents, size);
  }
  const toArray = (levels: Map<number, number>) => [...levels.entries()]
    .map(([priceCents, size]) => ({ priceCents, size }));
  return { bids: toArray(bids), asks: toArray(asks), updatedAt: now };
}

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SUBSCRIPTION_BATCH_SIZE = 100;
// A quote this old is treated as dead (the socket may be silently stalled without having
// actually closed) — callers should fall back to REST rather than trust it.
export const LIVE_QUOTE_STALE_MS = 15_000;

class PolymarketLiveBook {
  private ws: WebSocket | null = null;
  private quotes = new Map<string, LiveQuote>();
  private levels = new Map<string, LevelBook>();
  private subscribed: string[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private closing = false;
  private connectCount = 0;
  private lastMessageAt = 0;
  private initialSubscriptionEstablished = false;
  private updateListeners = new Set<(assetId: string) => void>();

  private notifyUpdate(assetId: string): void {
    for (const listener of this.updateListeners) {
      try { listener(assetId); } catch (error) { console.error("[polymarketLiveBook] update listener failed:", error); }
    }
  }

  private sendBatched(payload: (ids: string[]) => object, ids: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < ids.length; i += SUBSCRIPTION_BATCH_SIZE) {
      this.ws.send(JSON.stringify(payload(ids.slice(i, i + SUBSCRIPTION_BATCH_SIZE))));
    }
  }

  // Idempotent — safe to call repeatedly (e.g. once per ingest cycle).
  connect(): void {
    if (this.ws || this.closing) return;
    this.closing = false;
    this.openSocket();
  }

  private openSocket(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error("[polymarketLiveBook] failed to construct WebSocket:", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectCount += 1;

    ws.addEventListener("open", () => {
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.initialSubscriptionEstablished = false;
      // Book snapshots are asset-scoped; the server does not replay missed deltas on
      // reconnect, so a fresh subscribe always re-requests a full snapshot per asset.
      this.sendSubscribe();
      this.pingTimer = setInterval(() => {
        try {
          ws.send("PING");
        } catch {
          // let the next scheduled reconnect handle a dead socket
        }
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (ev) => {
      this.lastMessageAt = Date.now();
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (raw === "PONG") return;
      this.handleRaw(raw);
    });

    ws.addEventListener("close", () => {
      this.teardownSocket();
      if (!this.closing) this.scheduleReconnect();
    });

    ws.addEventListener("error", (e) => {
      console.error("[polymarketLiveBook] socket error:", (e as { message?: string }).message ?? e);
    });
  }

  private handleRaw(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    // A "book" snapshot arrives as a single-element array; price_change is a bare object.
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const book = parseBookSnapshot(entry as RawBookMsg, now);
      if (book) {
        this.quotes.set(book.assetId, book.quote);
        const levels = parseBookLevels(entry as RawBookMsg, now);
        if (levels) this.levels.set(levels.assetId, levels.levels);
        this.notifyUpdate(book.assetId);
        continue;
      }
      const changeMessage = entry as RawPriceChangeMsg;
      for (const { assetId, quote } of parsePriceChange(changeMessage, now)) {
        // Only track assets we actually subscribed to (both sides of a subscribed market
        // stream together, so this is a membership check, not a filter of real data).
        this.quotes.set(assetId, quote);
        const current = this.levels.get(assetId);
        if (current) this.levels.set(assetId, applyPriceChanges(current, changeMessage.price_changes ?? [], assetId, now));
        this.notifyUpdate(assetId);
      }
    }
  }

  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.subscribed.length === 0) return;
    // Establish the channel with one initial request, then use documented dynamic
    // subscription updates for the remaining batches.
    const first = this.subscribed.slice(0, SUBSCRIPTION_BATCH_SIZE);
    this.ws.send(JSON.stringify({ type: "market", assets_ids: first }));
    this.initialSubscriptionEstablished = true;
    this.sendBatched(
      (assets_ids) => ({ operation: "subscribe", assets_ids }),
      this.subscribed.slice(SUBSCRIPTION_BATCH_SIZE)
    );
  }

  private updateSubscription(operation: "subscribe" | "unsubscribe", tokenIds: string[]): void {
    this.sendBatched((assets_ids) => ({ operation, assets_ids }), tokenIds);
  }

  private teardownSocket(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
    this.lastMessageAt = 0;
    this.initialSubscriptionEstablished = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
      this.openSocket();
    }, this.reconnectDelayMs);
  }

  // Update the set of token ids we care about (today's MLB Polymarket markets, refreshed by
  // each REST ingest pass — REST is still how markets are DISCOVERED; the socket only keeps
  // already-known markets fresh). Subscribing to either side of a market streams both, so
  // duplicates collapse naturally. The subscribe protocol doesn't document incremental
  // add/remove, so a changed token set reconnects with the full new list — simple and
  // unambiguously correct, at the cost of a brief (sub-second) resubscribe gap.
  setTokens(tokenIds: string[]): void {
    const next = [...new Set(tokenIds.filter(Boolean))].sort();
    const prev = this.subscribed;
    if (next.length === prev.length && next.every((t, i) => t === prev[i])) return;
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    const added = next.filter((token) => !prevSet.has(token));
    const removed = prev.filter((token) => !nextSet.has(token));
    this.subscribed = next;
    // Drop quotes for tokens we no longer track so a stale price can't linger unbounded.
    for (const k of this.quotes.keys()) if (!nextSet.has(k)) this.quotes.delete(k);
    for (const k of this.levels.keys()) if (!nextSet.has(k)) this.levels.delete(k);
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (!this.initialSubscriptionEstablished && next.length) this.sendSubscribe();
      else {
        if (removed.length) this.updateSubscription("unsubscribe", removed);
        if (added.length) this.updateSubscription("subscribe", added);
      }
    }
    else this.connect();
  }

  requestSnapshot(tokenId: string): void {
    if (!this.subscribed.includes(tokenId) || this.ws?.readyState !== WebSocket.OPEN) return;
    // Polymarket has no standalone get_snapshot command. A targeted unsubscribe/subscribe
    // is the documented way to request a fresh initial book without disturbing the rest.
    this.updateSubscription("unsubscribe", [tokenId]);
    this.levels.delete(tokenId);
    this.quotes.delete(tokenId);
    setTimeout(() => this.updateSubscription("subscribe", [tokenId]), 25);
  }

  onUpdate(listener: (assetId: string) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  marketState(tokenId: string, now = Date.now()): LiveBookMarketState {
    if (this.ws?.readyState !== WebSocket.OPEN) return this.ws ? "connecting" : "disconnected";
    if (!this.subscribed.includes(tokenId)) return "disconnected";
    const level = this.levels.get(tokenId);
    if (!level) return "subscribed_waiting_snapshot";
    // A quiet market remains current while the ordered socket is demonstrably alive:
    // no delta means the book did not change. Keep the per-book timestamp for metrics,
    // but use the connection heartbeat for execution freshness after a snapshot exists.
    if (now - this.lastMessageAt > LIVE_QUOTE_STALE_MS) return "stale";
    if (!level.asks.some((entry) => entry.size > 0)) return "one_sided";
    return "ready";
  }

  // Fresh live quote for a token, or null if we have none / it's gone stale (caller should
  // fall back to REST — this is a real-time supplement, not a guaranteed source).
  getQuote(tokenId: string): LiveQuote | null {
    const q = this.quotes.get(tokenId);
    if (!q) return null;
    if (this.ws?.readyState !== WebSocket.OPEN || Date.now() - this.lastMessageAt > LIVE_QUOTE_STALE_MS) return null;
    return q;
  }

  // Contracts resting at or better than limitPriceCents on the given side, or null if we have
  // no ladder for this token / it's gone stale (caller should NOT treat null as "zero
  // liquidity" — it means "unknown", i.e. we only ever got price_change updates so far, or
  // haven't heard from the socket in a while).
  getDepth(tokenId: string, side: "bid" | "ask", limitPriceCents: number): number | null {
    const lv = this.levels.get(tokenId);
    if (!lv || this.ws?.readyState !== WebSocket.OPEN || Date.now() - this.lastMessageAt > LIVE_QUOTE_STALE_MS) return null;
    return depthAtOrBetter(side === "ask" ? lv.asks : lv.bids, side, limitPriceCents);
  }

  // Full ask ladder (price ascending), or null if we have no ladder for this token / it's
  // gone stale. Same {priceCents, contracts} shape as kalshiLiveBook's getAskLevels, so
  // callers can treat both venues' live ladders uniformly.
  getAskLevels(tokenId: string): Array<{ priceCents: number; contracts: number }> | null {
    const lv = this.levels.get(tokenId);
    if (!lv || this.marketState(tokenId) !== "ready") return null;
    return lv.asks
      .filter((l) => l.priceCents > 0 && l.priceCents < 100 && l.size > 0)
      .map((l) => ({ priceCents: l.priceCents, contracts: l.size }))
      .sort((a, b) => a.priceCents - b.priceCents);
  }

  getAskSnapshot(tokenId: string): { levels: Array<{ priceCents: number; contracts: number }>; updatedAt: number } | null {
    const lv = this.levels.get(tokenId);
    if (!lv || this.marketState(tokenId) !== "ready") return null;
    const levels = lv.asks
      .filter((level) => level.priceCents > 0 && level.priceCents < 100 && level.size > 0)
      .map((level) => ({ priceCents: level.priceCents, contracts: level.size }))
      .sort((a, b) => a.priceCents - b.priceCents);
    return levels.length ? { levels, updatedAt: this.lastMessageAt } : null;
  }

  status(): { connected: boolean; subscribedCount: number; quoteCount: number; readyCount: number; waitingSnapshotCount: number; staleCount: number; oneSidedCount: number; connectCount: number; oldestBookAgeMs: number | null } {
    const states = this.subscribed.map((token) => this.marketState(token));
    const ages = [...this.levels.values()].map((book) => Math.max(0, Date.now() - book.updatedAt));
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      subscribedCount: this.subscribed.length,
      quoteCount: this.quotes.size,
      readyCount: states.filter((state) => state === "ready").length,
      waitingSnapshotCount: states.filter((state) => state === "subscribed_waiting_snapshot").length,
      staleCount: states.filter((state) => state === "stale").length,
      oneSidedCount: states.filter((state) => state === "one_sided").length,
      connectCount: this.connectCount,
      oldestBookAgeMs: ages.length ? Math.max(...ages) : null,
    };
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.teardownSocket();
  }
}

// One connection for the whole server process (module-level singleton — Next.js self-hosted
// runs as one persistent Node process, so this survives across requests).
export const polymarketLiveBook = new PolymarketLiveBook();
