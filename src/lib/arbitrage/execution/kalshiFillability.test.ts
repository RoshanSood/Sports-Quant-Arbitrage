import { describe, it, expect, vi, beforeEach } from "vitest";

// checkKalshiFillability re-reads top-of-book before placement. A hard reject on ANY
// upward move false-blocked on transient one-tick drift (the logged "moved above limit"
// failures) — the IOC limit already protects price. It now allows a small tolerance.
vi.mock("@/lib/kalshiAuth", () => ({
  kalshiGet: vi.fn(),
  kalshiPost: vi.fn(),
  isKalshiConfigured: () => true,
}));

import { kalshiGet } from "@/lib/kalshiAuth";
import { checkKalshiFillability } from "./kalshiAdapter";
import type { OrderRequest } from "./types";

const mockGet = vi.mocked(kalshiGet);

function req(over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    venueId: "kalshi",
    marketId: "kalshi:1:moneyline:0:home",
    nativeMarketId: "KXMLBGAME-XYZ-ABC",
    nativeSide: "yes",
    outcome: "home",
    sizeContracts: 5,
    limitPriceCents: 50,
    ...over,
  };
}

function snapshot(yesAsk: number, size = 100) {
  return { market: { status: "active", yes_ask: yesAsk, yes_bid: 100 - yesAsk, yes_ask_size_fp: size, yes_bid_size_fp: size } };
}

describe("checkKalshiFillability tolerance", () => {
  beforeEach(() => {
    mockGet.mockReset();
    delete process.env.KALSHI_FILLABILITY_TOL_CENTS;
  });

  it("passes when top-of-book is at or below the limit", async () => {
    mockGet.mockResolvedValue(snapshot(49));
    expect(await checkKalshiFillability(req({ limitPriceCents: 50 }))).toEqual({ ok: true });
  });

  it("still passes on a 1-2c transient move (within default 2c tolerance)", async () => {
    mockGet.mockResolvedValue(snapshot(52)); // 2c over the 50c limit
    expect(await checkKalshiFillability(req({ limitPriceCents: 50 }))).toEqual({ ok: true });
  });

  it("blocks a genuine larger move beyond tolerance", async () => {
    mockGet.mockResolvedValue(snapshot(55)); // 5c over
    const r = await checkKalshiFillability(req({ limitPriceCents: 50 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/moved above limit/);
  });

  it("still enforces the size guard (naked-avoidance) regardless of tolerance", async () => {
    mockGet.mockResolvedValue(snapshot(50, 2)); // price fine, but only 2 contracts vs 5 needed
    const r = await checkKalshiFillability(req({ limitPriceCents: 50, sizeContracts: 5 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/size/);
  });
});
