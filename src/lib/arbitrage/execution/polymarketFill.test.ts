import { describe, it, expect } from "vitest";
import { avgCentsFrom, polymarketFillFromResponse, polymarketFillQuoteFromAsks } from "./polymarketAdapter";

// The phantom-fill bug: a killed/unmatched FOK returns success + a (client-computed) order
// hash but NO real shares in takingAmount. The old code fell back to the requested size and
// logged it "filled", leaving a naked hedge. Fills must come from actual shares received.
describe("polymarketFillFromResponse", () => {
  it("PHANTOM: success + orderID but no takingAmount -> ZERO fill, not the requested size", () => {
    const r = polymarketFillFromResponse({ success: true, orderID: "0xe9e41c...c44a" }, 3);
    expect(r).toEqual({ ok: false, filledContracts: 0, status: "unfilled" });
  });

  it("reports a real fill from takingAmount (shares received)", () => {
    const r = polymarketFillFromResponse({ success: true, orderID: "0xabc", status: "matched", takingAmount: "3", makingAmount: "1.44" }, 3);
    expect(r).toEqual({ ok: true, filledContracts: 3, status: "filled" });
  });

  it("treats fewer shares than requested as partial (FOK edge case, still real)", () => {
    const r = polymarketFillFromResponse({ success: true, takingAmount: "2", status: "matched" }, 3);
    expect(r).toEqual({ ok: true, filledContracts: 2, status: "partial" });
  });

  it("zero shares -> zero fill", () => {
    expect(polymarketFillFromResponse({ success: true, takingAmount: "0" }, 3)).toEqual({ ok: false, filledContracts: 0, status: "unfilled" });
  });

  it("keeps a delayed sports order pending until reconciliation confirms a trade", () => {
    expect(polymarketFillFromResponse({ success: true, orderID: "0xdelayed", status: "delayed" }, 6)).toEqual({
      ok: true,
      filledContracts: 0,
      status: "pending",
    });
  });

  it("explicit unmatched/cancelled status -> zero fill even if a stray amount is present", () => {
    expect(polymarketFillFromResponse({ success: true, status: "unmatched", takingAmount: "3" }, 3).ok).toBe(false);
    expect(polymarketFillFromResponse({ success: true, status: "cancelled", takingAmount: "3" }, 3).filledContracts).toBe(0);
  });

  it("error response -> zero fill", () => {
    expect(polymarketFillFromResponse({ error: "order not filled", takingAmount: "3" }, 3).ok).toBe(false);
    expect(polymarketFillFromResponse({ errorMsg: "maker address not allowed", takingAmount: "3" }, 3).ok).toBe(false);
  });
});

// Sizing the FOK to the live book (so it fills instead of getting killed for over-asking).
describe("polymarketFillQuoteFromAsks", () => {
  it("walks the ask ladder up to the target, worst crossed price = send-limit", () => {
    const q = polymarketFillQuoteFromAsks([{ price: "0.46", size: "2" }, { price: "0.47", size: "5" }], 48, 4);
    expect(q).not.toBeNull();
    expect(q!.availableContracts).toBe(4);
    expect(q!.limitPriceCents).toBe(47); // worst ask crossed
    expect(q!.avgPriceCents).toBeCloseTo(46.5, 5);
  });

  it("caps at available depth when the book holds less than requested (fills smaller, not killed)", () => {
    const q = polymarketFillQuoteFromAsks([{ price: "0.46", size: "3" }], 48, 10);
    expect(q!.availableContracts).toBe(3);
  });

  it("returns null when nothing is offered at or below our price (arb moved away)", () => {
    expect(polymarketFillQuoteFromAsks([{ price: "0.50", size: "10" }], 48, 4)).toBeNull();
    expect(polymarketFillQuoteFromAsks([], 48, 4)).toBeNull();
    expect(polymarketFillQuoteFromAsks(undefined, 48, 4)).toBeNull();
  });

  it("ignores malformed / out-of-range ask levels", () => {
    const q = polymarketFillQuoteFromAsks([{ price: "0", size: "5" }, { price: "1.2", size: "5" }, { price: "0.46", size: "4" }], 48, 4);
    expect(q!.availableContracts).toBe(4);
    expect(q!.limitPriceCents).toBe(46);
  });
});

// The portfolio must show what was ACTUALLY paid. A FOK that crosses the ask ladder fills a
// few tenths above the detected top-of-book (e.g. 79.8c), so the reported avg keeps sub-cent
// precision instead of rounding to a whole cent (which understated cost & overstated profit).
describe("avgCentsFrom", () => {
  it("keeps sub-cent precision from USDC paid / shares (79.8c, not 80c)", () => {
    expect(avgCentsFrom({ makingAmount: "3.192", takingAmount: "4" }, 79)).toBeCloseTo(79.8, 5);
  });

  it("falls back to our limit when the fill amounts are absent", () => {
    expect(avgCentsFrom({ takingAmount: "4" }, 79)).toBe(79);
    expect(avgCentsFrom({}, 77)).toBe(77);
  });

  it("zero/invalid shares → limit (no divide-by-zero)", () => {
    expect(avgCentsFrom({ makingAmount: "3.19", takingAmount: "0" }, 80)).toBe(80);
  });
});
