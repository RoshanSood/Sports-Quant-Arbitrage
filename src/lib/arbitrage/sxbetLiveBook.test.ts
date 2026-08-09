import { describe, it, expect } from "vitest";
import { bestAsksFromOrders } from "./sxbetLiveBook";

// percentageOdds is a fixed-point probability scaled by 1e20 (same convention as this
// codebase's existing REST reader, sxbet.ts's bestPrices). Compute the string instead of
// hand-typing 20 zeros, which is exactly the kind of transcription error that would silently
// misprice a live order.
const odds = (p: number) => String(Math.round(p * 1e20));

// Order shape matches SX.bet's documented Centrifugo order_book publication AND this
// codebase's existing REST SxOrder type (sxbet.ts) — same percentageOdds/fillAmount/
// isMakerBettingOutcomeOne fields, so the same odds math applies. Not live-verified.
describe("sxbetLiveBook — bestAsksFromOrders", () => {
  it("computes o1/o2 ask cents from active orders on both sides", () => {
    const orders = new Map(
      Object.entries({
        a: { status: "ACTIVE", percentageOdds: odds(0.7), totalBetSize: "1000000", fillAmount: "0", isMakerBettingOutcomeOne: false },
        b: { status: "ACTIVE", percentageOdds: odds(0.6), totalBetSize: "1000000", fillAmount: "0", isMakerBettingOutcomeOne: true },
      })
    );
    const { o1AskCents, o2AskCents } = bestAsksFromOrders(orders);
    expect(o1AskCents).toBeCloseTo(30, 4); // (1 - 0.7) * 100
    expect(o2AskCents).toBeCloseTo(40, 4); // (1 - 0.6) * 100
  });

  it("ignores INACTIVE (cancelled) and fully-filled orders", () => {
    const orders = new Map(
      Object.entries({
        cancelled: { status: "INACTIVE", percentageOdds: odds(0.7), totalBetSize: "1000000", fillAmount: "0", isMakerBettingOutcomeOne: false },
        filled: { status: "ACTIVE", percentageOdds: odds(0.8), totalBetSize: "1000000", fillAmount: "1000000", isMakerBettingOutcomeOne: false },
      })
    );
    expect(bestAsksFromOrders(orders)).toEqual({ o1AskCents: null, o2AskCents: null });
  });

  it("picks the BEST (highest maker odds -> lowest taker cost) among multiple orders on one side", () => {
    const orders = new Map(
      Object.entries({
        a: { status: "ACTIVE", percentageOdds: odds(0.5), totalBetSize: "1000000", fillAmount: "0", isMakerBettingOutcomeOne: false },
        b: { status: "ACTIVE", percentageOdds: odds(0.7), totalBetSize: "1000000", fillAmount: "0", isMakerBettingOutcomeOne: false },
      })
    );
    expect(bestAsksFromOrders(orders).o1AskCents).toBeCloseTo(30, 4); // best (highest 0.7) wins
  });

  it("returns nulls for an empty book", () => {
    expect(bestAsksFromOrders(new Map())).toEqual({ o1AskCents: null, o2AskCents: null });
  });
});
