import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudbetExecutionAdapter } from "./cloudbetAdapter";
import type { OrderRequest } from "./types";

const request: OrderRequest = {
  venueId: "cloudbet",
  marketId: "cloudbet:test",
  nativeMarketId: "event-1",
  nativeSide: "baseball.moneyline/home",
  outcome: "home",
  sizeContracts: 3,
  limitPriceCents: 40,
  clientOrderId: "reference-1",
};

describe("Cloudbet pending acceptance", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns pending immediately and lets reconciliation own status polling", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "PENDING_ACCEPTANCE", referenceId: "reference-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CloudbetExecutionAdapter({ apiKey: "test-key" }).placeOrder(request);
    expect(result).toMatchObject({ ok: true, orderId: "reference-1", status: "pending", filledContracts: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls final status with GET by reference id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ACCEPTED", price: "2.5" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CloudbetExecutionAdapter({ apiKey: "test-key" }).confirmFill("reference-1", request);
    expect(result.status).toBe("settled");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sports-api.cloudbet.com/pub/v3/bets/reference-1/status",
      expect.objectContaining({ method: "GET" })
    );
  });
});
