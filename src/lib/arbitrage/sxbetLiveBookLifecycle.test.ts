import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeState = vi.hoisted(() => ({
  clients: [] as Array<{ subscriptions: Map<string, unknown> }>,
  failChannels: new Set<string>(),
}));

vi.mock("centrifuge", () => {
  class FakeSubscription {
    state = "unsubscribed";
    constructor(public channel: string) {}
    on() { return this; }
    subscribe() { this.state = "subscribed"; }
    unsubscribe() { this.state = "unsubscribed"; }
  }

  class Centrifuge {
    state = "disconnected";
    subscriptions = new Map<string, FakeSubscription>();
    constructor() { fakeState.clients.push(this); }
    on() { return this; }
    connect() { this.state = "connected"; }
    disconnect() { this.state = "disconnected"; }
    getSubscription(channel: string) { return this.subscriptions.get(channel) ?? null; }
    newSubscription(channel: string) {
      if (fakeState.failChannels.has(channel)) throw new Error(`forced failure ${channel}`);
      if (this.subscriptions.has(channel)) throw new Error(`Subscription to the channel ${channel} already exists`);
      const sub = new FakeSubscription(channel);
      this.subscriptions.set(channel, sub);
      return sub;
    }
    removeSubscription(sub: FakeSubscription | null) {
      if (!sub) return;
      sub.unsubscribe();
      this.subscriptions.delete(sub.channel);
    }
  }

  return { Centrifuge };
});

import { SxBetLiveBook } from "./sxbetLiveBook";

describe("SX live-book subscription lifecycle", () => {
  beforeEach(() => {
    fakeState.clients.length = 0;
    fakeState.failChannels.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("can resubscribe when a market set changes A -> B -> A", () => {
    const book = new SxBetLiveBook();
    book.connect("test-key");

    expect(() => {
      book.setMarkets(["A"]);
      book.setMarkets(["B"]);
      book.setMarkets(["A"]);
    }).not.toThrow();

    expect(book.status().subscribedCount).toBe(1);
    expect([...fakeState.clients[0].subscriptions.keys()]).toEqual(["order_book:market_A"]);
  });

  it("isolates one failed channel and continues subscribing other markets", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakeState.failChannels.add("order_book:market_bad");
    const book = new SxBetLiveBook();
    book.connect("test-key");

    expect(() => book.setMarkets(["bad", "good"])).not.toThrow();
    expect(book.status().subscribedCount).toBe(1);
    expect([...fakeState.clients[0].subscriptions.keys()]).toEqual(["order_book:market_good"]);
  });

  it("removes subscriptions from both registries when closed", () => {
    const book = new SxBetLiveBook();
    book.connect("test-key");
    book.setMarkets(["A", "B"]);

    book.close();

    expect(book.status()).toEqual({ connected: false, subscribedCount: 0, quoteCount: 0 });
    expect(fakeState.clients[0].subscriptions.size).toBe(0);
  });
});
