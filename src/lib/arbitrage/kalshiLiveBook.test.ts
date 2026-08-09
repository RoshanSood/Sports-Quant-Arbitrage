import { describe, it, expect } from "vitest";
import { applySnapshot, applyDelta, depthAtOrBetter, isSequenceGap } from "./kalshiLiveBook";

// Fixtures match the REAL orderbook_snapshot / orderbook_delta schema, live-verified
// 2026-08-09 against the real feed with real credentials — not the (incorrect) docs. See
// kalshiLiveBook.ts header for what was wrong and how it was confirmed.
describe("kalshiLiveBook — applySnapshot", () => {
  it("builds yes/no level maps (price cents -> qty) from the real snapshot shape", () => {
    const parsed = applySnapshot({
      market_ticker: "KXBTC-26JAN15-T100000",
      yes_dollars_fp: [["0.4700", "300.00"], ["0.4600", "150.00"]],
      no_dollars_fp: [["0.5300", "200.00"], ["0.5400", "100.00"]],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.yes.get(47)).toBe(300);
    expect(parsed!.no.get(54)).toBe(100);
  });

  it("drops zero/invalid-quantity levels", () => {
    const parsed = applySnapshot({
      market_ticker: "T",
      yes_dollars_fp: [["0.5000", "0.00"], ["0.4000", "10.00"]],
      no_dollars_fp: [],
    });
    expect(parsed!.yes.has(50)).toBe(false);
    expect(parsed!.yes.get(40)).toBe(10);
  });

  it("returns null for a malformed snapshot", () => {
    expect(applySnapshot({})).toBeNull();
    expect(applySnapshot({ market_ticker: "T" })).toBeNull();
  });
});

describe("kalshiLiveBook — applyDelta", () => {
  it("adds a new level from the documented delta shape", () => {
    const levels = applyDelta(new Map(), { price_dollars: "0.960", delta_fp: "54.00", side: "yes" });
    expect(levels.get(96)).toBe(54);
  });

  it("increments an existing level", () => {
    const levels = applyDelta(new Map([[96, 54]]), { price_dollars: "0.960", delta_fp: "10" });
    expect(levels.get(96)).toBe(64);
  });

  it("removes a level when the delta brings it to zero or below", () => {
    const levels = applyDelta(new Map([[96, 54]]), { price_dollars: "0.960", delta_fp: "-54.00" });
    expect(levels.has(96)).toBe(false);
  });

  it("leaves levels unchanged on a malformed delta", () => {
    const original = new Map([[96, 54]]);
    expect(applyDelta(original, { price_dollars: "bad", delta_fp: "10" })).toBe(original);
  });
});

describe("kalshiLiveBook — depthAtOrBetter (liquidity checks)", () => {
  // Buying yes at <= 55c fills against NO bids priced >= 45c (100 - 55) — the complement
  // relationship this module already uses for best-ask (see updateQuote).
  const noBids = new Map([
    [40, 100], // complement yes-ask = 60c — too expensive for a 55c limit
    [45, 200], // complement yes-ask = 55c — exactly at the limit, included
    [50, 300], // complement yes-ask = 50c — better than the limit, included
  ]);

  it("sums opposite-side bid quantity whose complement price clears the limit", () => {
    expect(depthAtOrBetter(noBids, 55)).toBe(500); // the 45c and 50c levels (200 + 300)
    expect(depthAtOrBetter(noBids, 50)).toBe(300); // only the 50c level
    expect(depthAtOrBetter(noBids, 30)).toBe(0); // nothing clears a 30c limit
  });
});

describe("kalshiLiveBook — isSequenceGap (connection-wide, NOT per-ticker)", () => {
  it("is never a gap on the first message seen (no baseline yet)", () => {
    expect(isSequenceGap(null, 1)).toBe(false);
    expect(isSequenceGap(null, 4512)).toBe(false);
  });

  it("is not a gap for the immediate next seq in the SAME connection-wide stream", () => {
    // This is the case that matters: seq 1, 2, 3, 4, 5 arriving for FIVE DIFFERENT tickers
    // (one snapshot each) in the initial subscribe burst — live-verified shape. None of
    // these are gaps even though each belongs to a different ticker.
    expect(isSequenceGap(1, 2)).toBe(false);
    expect(isSequenceGap(4, 5)).toBe(false);
  });

  it("tolerates exactly ONE missing seq number — Kalshi's own subscribe-command overhead, not real loss", () => {
    expect(isSequenceGap(5, 7)).toBe(false); // missing only 6
    expect(isSequenceGap(16, 18)).toBe(false); // the live-verified re-subscribe artifact
  });

  it("IS a gap when MORE than one message was actually dropped", () => {
    expect(isSequenceGap(5, 8)).toBe(true); // missing 6 AND 7
    expect(isSequenceGap(100, 250)).toBe(true);
  });

  it("treats a missing seq on either side as unknown, not a gap", () => {
    expect(isSequenceGap(5, null)).toBe(false);
  });
});
