import { describe, it, expect } from "vitest";
import { depthAtOrBetter, parseBookLevels, parseBookSnapshot, parsePriceChange } from "./polymarketLiveBook";

// Fixtures captured from the LIVE wss://ws-subscriptions-clob.polymarket.com/ws/market feed
// (verified against a real subscribed token before writing the parser) — not hand-guessed.
describe("polymarketLiveBook — parseBookSnapshot (live-captured shape)", () => {
  it("computes best bid (max) / best ask (min) from the snapshot's price levels", () => {
    const msg = {
      market: "0x3df7be753c8b6ebbddf31d6d63535c4b31c836cb25b1a73085508a271bc103db",
      asset_id: "52854035362787091895017612076763457120573181014952605669517525908999466984865",
      timestamp: "1786227505976",
      hash: "749f0898679a95c3aaa485b4559df184f636c339",
      bids: [{ price: "0.05", size: "1406" }, { price: "0.07", size: "5377.63" }, { price: "0.02", size: "1300" }],
      asks: [{ price: "0.99", size: "2200007.87" }, { price: "0.97", size: "40000" }, { price: "0.98", size: "700009.81" }],
      tick_size: "0.01",
      event_type: "book",
    };
    const parsed = parseBookSnapshot(msg, 1000);
    expect(parsed).not.toBeNull();
    expect(parsed!.assetId).toBe(msg.asset_id);
    expect(parsed!.quote.bestBidCents).toBeCloseTo(7, 5); // max of 5,7,2
    expect(parsed!.quote.bestAskCents).toBeCloseTo(97, 5); // min of 99,97,98 — NOT positional
    expect(parsed!.quote.updatedAt).toBe(1000);
  });

  it("ignores zero-size levels (removed from the book)", () => {
    const parsed = parseBookSnapshot(
      { asset_id: "a", event_type: "book", bids: [{ price: "0.5", size: "0" }, { price: "0.4", size: "10" }], asks: [] },
      1000
    );
    expect(parsed!.quote.bestBidCents).toBeCloseTo(40, 5);
    expect(parsed!.quote.bestAskCents).toBeNull();
  });

  it("returns null for a non-book message", () => {
    expect(parseBookSnapshot({ event_type: "price_change" }, 1000)).toBeNull();
    expect(parseBookSnapshot({}, 1000)).toBeNull();
  });
});

describe("polymarketLiveBook — parsePriceChange (live-captured shape)", () => {
  it("reads best_bid/best_ask directly per entry (server already recomputed them)", () => {
    const msg = {
      market: "0x3df7be753c8b6ebbddf31d6d63535c4b31c836cb25b1a73085508a271bc103db",
      price_changes: [
        { asset_id: "95543103909155130948704747260000445052441626108012711535497120196961332271236", price: "0.03", size: "0", side: "BUY", best_bid: "0.9", best_ask: "0.92" },
      ],
      timestamp: "1786227506000",
      event_type: "price_change",
    };
    const out = parsePriceChange(msg, 2000);
    expect(out).toHaveLength(1);
    expect(out[0].assetId).toBe(msg.price_changes[0].asset_id);
    expect(out[0].quote).toEqual({ bestBidCents: 90, bestAskCents: 92, updatedAt: 2000 });
  });

  it("carries updates for BOTH complementary asset ids in one message", () => {
    const msg = {
      event_type: "price_change",
      price_changes: [
        { asset_id: "tokenA", best_bid: "0.08", best_ask: "0.1" },
        { asset_id: "tokenB", best_bid: "0.9", best_ask: "0.92" },
      ],
    };
    const out = parsePriceChange(msg, 1000);
    expect(out.map((o) => o.assetId).sort()).toEqual(["tokenA", "tokenB"]);
  });

  it("returns [] for a non-price_change message or an empty list", () => {
    expect(parsePriceChange({ event_type: "book" }, 1000)).toEqual([]);
    expect(parsePriceChange({ event_type: "price_change", price_changes: [] }, 1000)).toEqual([]);
  });
});

describe("polymarketLiveBook — parseBookLevels + depthAtOrBetter (liquidity checks)", () => {
  const msg = {
    asset_id: "a",
    event_type: "book",
    bids: [{ price: "0.05", size: "1406" }, { price: "0.07", size: "5377.63" }],
    asks: [{ price: "0.97", size: "40000" }, { price: "0.98", size: "700009.81" }],
  };

  it("builds a full price->size ladder for both sides", () => {
    const parsed = parseBookLevels(msg, 1000);
    expect(parsed).not.toBeNull();
    expect(parsed!.levels.asks).toEqual(
      expect.arrayContaining([{ priceCents: 97, size: 40000 }, { priceCents: 98, size: 700009.81 }])
    );
  });

  it("sums size at or better than a limit price for asks (buying) — cheaper levels included", () => {
    const parsed = parseBookLevels(msg, 1000)!;
    expect(depthAtOrBetter(parsed.levels.asks, "ask", 97)).toBe(40000); // only the 97c level clears <=97
    expect(depthAtOrBetter(parsed.levels.asks, "ask", 98)).toBeCloseTo(740009.81, 2); // both levels
    expect(depthAtOrBetter(parsed.levels.asks, "ask", 90)).toBe(0); // neither level clears <=90
  });

  it("sums size at or better than a limit price for bids (selling) — pricier levels included", () => {
    const parsed = parseBookLevels(msg, 1000)!;
    expect(depthAtOrBetter(parsed.levels.bids, "bid", 7)).toBeCloseTo(5377.63, 2);
    expect(depthAtOrBetter(parsed.levels.bids, "bid", 5)).toBeCloseTo(1406 + 5377.63, 2);
  });

  it("returns null for a non-book message", () => {
    expect(parseBookLevels({ event_type: "price_change" }, 1000)).toBeNull();
  });
});
