import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArbLeg } from "@/types/arbitrage";
import { QuoteRefreshError, refreshLegQuotes, walkBook } from "./quoteRefresh";

function leg(venueId: string, nativeMarketId: string, nativeSide: string): ArbLeg {
  return {
    venueId,
    marketId: `${venueId}:1:total:8.5:over`,
    nativeMarketId,
    nativeSide,
    outcome: "over",
    priceCents: 50,
    decimalOdds: 2,
    impliedProbability: 0.5,
    size: 10,
    feeCents: 0,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("full-depth quote refresh", () => {
  it("uses the worst consumed level as the safe limit", () => {
    expect(walkBook([{ price: 0.48, contracts: 4 }, { price: 0.5, contracts: 10 }], 10)).toEqual({
      priceCents: 50,
      liquidityUsd: 6.92,
    });
  });

  it("fails when the requested size is not executable", () => {
    expect(() => walkBook([{ price: 0.5, contracts: 2 }], 3)).toThrow(QuoteRefreshError);
  });

  it("refreshes Kalshi and Polymarket directly from their books", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ orderbook_fp: { no_dollars: [["0.52", "10.00"]] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.49", size: "10" }] }), { status: 200 }));
    const refreshed = await refreshLegQuotes([
      leg("kalshi", "KX-ONE", "yes"),
      leg("polymarket", "poly-token", "buy"),
    ]);
    expect(refreshed.map((item) => item.priceCents)).toEqual([48, 49]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
