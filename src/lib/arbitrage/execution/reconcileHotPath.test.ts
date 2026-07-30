import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArbLeg } from "@/types/arbitrage";
import type { ExecutionAdapter, OrderRequest, OrderResult, FillConfirmation } from "./types";
import type { PreparedContext } from "../executionPipeline";

// ─────────────────────────────────────────────────────────────────────────────
// #3 — settlement reconciliation is OFF the hot path. runExecution now runs
// reconcileLegs in a background `void (async () => …)()` AFTER writeLog and
// returns immediately; the old code AWAITED reconcileLegs (up to
// ARB_RECON_ATTEMPTS × ARB_RECON_DELAY_MS ≈ 4.5s) before returning.
//
// We drive the REAL runExecution with a ready prepared-context (mocked
// prepareExecution), mocked registry adapters whose confirmFill sleeps
// RECON_SLEEP_MS, a mocked tradeStore, and the REAL reconcile module. We then
// assert runExecution resolves in << RECON_SLEEP_MS, and separately observe the
// background pass finishing only AFTER the return (via updateTrade firing).
// ─────────────────────────────────────────────────────────────────────────────

const RECON_SLEEP_MS = 1500;

// Deferred so the test can await the background reconciliation's completion.
let backgroundDone: Promise<{ at: number }>;
let resolveBackground: (v: { at: number }) => void;
let confirmFillCompletedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function leg(venueId: string): ArbLeg {
  return {
    venueId,
    marketId: `${venueId}:m`,
    nativeMarketId: `${venueId}:native`,
    nativeSide: "yes",
    outcome: "home",
    priceCents: 48,
    decimalOdds: 100 / 48,
    impliedProbability: 0.48,
    size: 5,
    feeCents: 0,
    label: "Home",
  };
}

// Two neutral venues so NO fillability/preflight branch (sxbet/kalshi/polymarket)
// fires — placement is a plain Promise.all and the only slow work is confirmFill.
const LEGS = [leg("alpha"), leg("beta")];

function readyCtx(): PreparedContext {
  return {
    agent: { id: "arb", paper: false, live: true, enabled: true, strategy: "arbitrage", minEdge: 0.001, maxStake: 1000 } as unknown as PreparedContext["agent"],
    risk: { killSwitch: false, maxLiveStakeUsd: 1000, minExpectedProfitUsd: 0, maxExposure: 100000, staleQuoteMs: 999999 } as unknown as PreparedContext["risk"],
    opportunityId: "opp-1",
    opportunityMatchup: "Team A v Team B",
    venues: ["alpha", "beta"],
    executedLegs: LEGS,
    legSizes: { alpha: 2.4, beta: 2.4 },
    fees: [{ venueId: "alpha", feeCents: 0 }, { venueId: "beta", feeCents: 0 }] as unknown as PreparedContext["fees"],
    totalStake: 4.8,
    guaranteedPayout: 5,
    expectedProfit: 0.2,
    netAfter: 0.02,
    executionSteps: [],
    timing: {},
  };
}

// A mock adapter: placeOrder fills fully & instantly; confirmFill sleeps then
// reports a DIFFERENT (failed) settlement for leg 0 so the background pass has a
// correction to apply (proving it truly runs) — leg 1 settles as-placed.
function mockAdapter(venueId: string, failOnSettle: boolean): ExecutionAdapter {
  return {
    id: venueId,
    supportsLive: () => true,
    getBalanceUsd: async () => 1000,
    placeOrder: async (req: OrderRequest): Promise<OrderResult> => ({
      ok: true,
      orderId: `${venueId}-order`,
      filledContracts: req.sizeContracts,
      avgPriceCents: req.limitPriceCents,
      status: "filled",
    }),
    confirmFill: async (): Promise<FillConfirmation> => {
      await sleep(RECON_SLEEP_MS);
      confirmFillCompletedAt = performance.now();
      return failOnSettle ? { status: "failed" } : { status: "settled", filledContracts: 5 };
    },
  };
}

vi.mock("../executionPipeline", async () => {
  return {
    POLYMARKET_MIN_MARKET_BUY_USD: 1.01,
    prepareExecution: vi.fn(async () => ({ kind: "ready", ctx: readyCtx() })),
    verifyPostFill: vi.fn(async () => ({ checkedAt: new Date().toISOString(), status: "arb_gone", remainingNetEdge: null, edgeDrift: null, reason: "bench" })),
    writeLog: vi.fn(async () => ({})),
  };
});

vi.mock("./registry", async () => {
  return {
    getAdapter: (venueId: string) => mockAdapter(venueId, venueId === "alpha"),
    venueSupportsLive: (venues: string[]) => Object.fromEntries(venues.map((v) => [v, true])),
  };
});

vi.mock("../tradeStore", async () => {
  return {
    saveTrade: vi.fn(async () => {}),
    // updateTrade is called by the BACKGROUND reconciliation pass once settlement
    // differs — use it as the signal that the background work completed.
    updateTrade: vi.fn(async () => {
      resolveBackground({ at: performance.now() });
    }),
  };
});

import { runExecution } from "./executor";

describe("#3 reconcile runs off the hot path", () => {
  beforeEach(() => {
    confirmFillCompletedAt = 0;
    backgroundDone = new Promise((res) => {
      resolveBackground = res;
    });
  });

  it("runExecution returns in << the reconcile settlement time", async () => {
    const t0 = performance.now();
    const outcome = await runExecution("opp-1", "20990102", "live");
    const returnLatency = performance.now() - t0;

    // Immediate outcome derives from the acks (both legs filled) — executed.
    expect(outcome.mode).toBe("live");
    expect(outcome.result).toBe("executed");

    // The reconcile confirmFill sleeps RECON_SLEEP_MS; the function must return
    // long before that. Generous ceiling to stay non-flaky on a loaded machine.
    expect(returnLatency).toBeLessThan(RECON_SLEEP_MS / 2);
    // confirmFill has NOT completed yet at the moment runExecution returned.
    expect(confirmFillCompletedAt).toBe(0);

    // Now let the background pass finish and confirm it did the correction.
    const bg = await backgroundDone;
    const bgLatency = bg.at - t0;

    /* eslint-disable no-console */
    console.log("\n#3 reconcile off hot path:");
    console.log(`  reconcile settlement sleep (confirmFill): ${RECON_SLEEP_MS} ms`);
    console.log(`  runExecution return latency:              ${returnLatency.toFixed(1)} ms`);
    console.log(`  background reconciliation completed at:    ${bgLatency.toFixed(1)} ms (after return)`);
    console.log(`  hot-path time saved vs awaiting reconcile: ~${(bgLatency - returnLatency).toFixed(1)} ms`);
    /* eslint-enable no-console */

    // The background correction landed strictly AFTER runExecution returned.
    expect(bgLatency).toBeGreaterThan(returnLatency);
    expect(bgLatency).toBeGreaterThanOrEqual(RECON_SLEEP_MS * 0.8);
  }, 30_000);
});
