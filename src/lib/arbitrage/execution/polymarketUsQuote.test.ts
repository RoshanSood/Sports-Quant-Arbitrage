import { describe, it, expect, vi, beforeEach } from "vitest";

// The US FOK depth check must read the SAME central book the order fires on, keyed by
// market slug + yes/no side — not the intl CLOB (which would throw on a yes/no "token id").
vi.mock("@/lib/polymarketUs", () => ({
  fetchPolymarketUsSideQuote: vi.fn(),
}));

import { fetchPolymarketUsSideQuote } from "@/lib/polymarketUs";
import { quotePolymarketUsFokBuy } from "./polymarketUsAdapter";
import type { OrderRequest } from "./types";

const mockQuote = vi.mocked(fetchPolymarketUsSideQuote);

function req(over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    venueId: "polymarket",
    marketId: "polymarket:1:total:8.5:over",
    nativeMarketId: "mlb-reds-phillies-total-8-5",
    nativeSide: "yes",
    outcome: "over",
    sizeContracts: 4,
    limitPriceCents: 50,
    ...over,
  };
}

describe("quotePolymarketUsFokBuy", () => {
  beforeEach(() => mockQuote.mockReset());

  it("returns a fill quote at the live ask when depth exists at or below the limit", async () => {
    mockQuote.mockResolvedValue({ askCents: 48, availableContracts: 10 });
    const q = await quotePolymarketUsFokBuy(req());
    expect(mockQuote).toHaveBeenCalledWith("mlb-reds-phillies-total-8-5", "yes");
    expect(q).toEqual({ limitPriceCents: 48, avgPriceCents: 48, availableContracts: 10, availableStakeUsd: 4.8 });
  });

  it("returns null when the live ask is above our max price (unfillable)", async () => {
    mockQuote.mockResolvedValue({ askCents: 55, availableContracts: 10 });
    expect(await quotePolymarketUsFokBuy(req(), undefined, 50)).toBeNull();
  });

  it("returns null when there is no ask depth", async () => {
    mockQuote.mockResolvedValue({ askCents: 48, availableContracts: 0 });
    expect(await quotePolymarketUsFokBuy(req())).toBeNull();
  });

  it("returns null (no network call) for a missing slug or side", async () => {
    expect(await quotePolymarketUsFokBuy(req({ nativeSide: undefined }))).toBeNull();
    expect(await quotePolymarketUsFokBuy(req({ nativeMarketId: undefined }))).toBeNull();
    expect(mockQuote).not.toHaveBeenCalled();
  });
});
