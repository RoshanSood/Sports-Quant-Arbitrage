import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cbBalanceResult,
  cbUsdPerCurrencyUnit,
  CloudbetExecutionAdapter,
} from "./cloudbetAdapter";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Cloudbet account balance", () => {
  it("parses Cloudbet's string amount envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ amount: "1.2345" }), { status: 200 })
    ));

    await expect(cbBalanceResult("test-key", "SOL")).resolves.toEqual({
      ok: true,
      amount: 1.2345,
    });
  });

  it("treats USD stablecoins as one USD per native unit", () => {
    expect(cbUsdPerCurrencyUnit("USDC")).toBe(1);
    expect(cbUsdPerCurrencyUnit("usdt")).toBe(1);
  });

  it("does not enable live USD sizing for SOL without an explicit rate", async () => {
    vi.stubEnv("CLOUDBET_SOL_USD_RATE", "");
    vi.stubEnv("CLOUDBET_CURRENCY_USD_RATE", "");
    const adapter = new CloudbetExecutionAdapter({ apiKey: "test-key", currency: "SOL" });

    expect(adapter.supportsLive()).toBe(false);
    await expect(adapter.getBalanceUsd()).resolves.toBeNull();
  });

  it("converts a native SOL balance to USD when a rate is configured", async () => {
    vi.stubEnv("CLOUDBET_SOL_USD_RATE", "150");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ amount: "2" }), { status: 200 })
    ));
    const adapter = new CloudbetExecutionAdapter({ apiKey: "test-key", currency: "SOL" });

    expect(adapter.supportsLive()).toBe(true);
    await expect(adapter.getBalanceUsd()).resolves.toBe(300);
  });

  it("converts USD stake sizing into the configured native currency", async () => {
    vi.stubEnv("CLOUDBET_SOL_USD_RATE", "100");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ACCEPTED", price: "2" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new CloudbetExecutionAdapter({ apiKey: "test-key", currency: "SOL" });

    const result = await adapter.placeOrder({
      venueId: "cloudbet",
      marketId: "cloudbet:test",
      nativeMarketId: "event-1",
      nativeSide: "baseball.moneyline/home",
      outcome: "home",
      sizeContracts: 10,
      limitPriceCents: 50,
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      currency: "SOL",
      stake: "0.050000",
    });
    expect(result).toMatchObject({ ok: true, filledContracts: 10, avgPriceCents: 50 });
  });
});
