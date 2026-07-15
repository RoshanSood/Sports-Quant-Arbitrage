import { afterEach, describe, expect, it } from "vitest";
import { resolveExecutionMode, type GateInput } from "./config";
import { summarizeFills } from "./executor";
import { DryRunAdapter } from "./dryRunAdapter";
import type { ArbLeg } from "@/types/arbitrage";
import type { OrderResult } from "./types";

// The gate must FAIL CLOSED: live only when every independent switch passes.
const base: GateInput = {
  requestedMode: "live",
  agentPaper: false,
  killSwitch: false,
  venues: ["kalshi"],
  stakeUsd: 1,
  venuesSupportLive: { kalshi: true },
};

describe("execution safety gate", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  function armEnv() {
    process.env.ARB_EXECUTION_MODE = "live";
    process.env.ARB_LIVE_VENUES = "kalshi";
    process.env.ARB_MAX_LIVE_STAKE_USD = "10";
  }

  it("defaults to dry_run when env is not configured", () => {
    delete process.env.ARB_EXECUTION_MODE;
    const d = resolveExecutionMode(base);
    expect(d.mode).toBe("dry_run");
    expect(d.blockers.length).toBeGreaterThan(0);
  });

  it("goes live only when EVERY switch passes", () => {
    armEnv();
    const d = resolveExecutionMode(base);
    expect(d.mode).toBe("live");
    expect(d.blockers).toEqual([]);
  });

  it("stays dry_run if the caller only requested dry_run", () => {
    armEnv();
    expect(resolveExecutionMode({ ...base, requestedMode: "dry_run" }).mode).toBe("dry_run");
  });

  it("blocks live for paper agent, kill switch, or over the stake cap", () => {
    armEnv();
    expect(resolveExecutionMode({ ...base, agentPaper: true }).mode).toBe("dry_run");
    expect(resolveExecutionMode({ ...base, killSwitch: true }).mode).toBe("dry_run");
    expect(resolveExecutionMode({ ...base, stakeUsd: 999 }).mode).toBe("dry_run");
  });

  it("blocks live when a venue is not allowlisted or has no credentials", () => {
    armEnv();
    // polymarket not in ARB_LIVE_VENUES and no live adapter
    const d = resolveExecutionMode({ ...base, venues: ["kalshi", "polymarket"], venuesSupportLive: { kalshi: true, polymarket: false } });
    expect(d.mode).toBe("dry_run");
    expect(d.blockers.some((b) => b.includes("polymarket"))).toBe(true);
  });
});

function planned(priceCents: number): ArbLeg {
  return {
    venueId: priceCents === 45 ? "kalshi" : "polymarket",
    marketId: `venue:1:total:6.5:${priceCents === 45 ? "over" : "under"}`,
    outcome: priceCents === 45 ? "over" : "under",
    priceCents,
    decimalOdds: 100 / priceCents,
    impliedProbability: priceCents / 100,
    size: 20,
    feeCents: 0,
  };
}

function fill(filledContracts: number, priceCents: number): OrderResult {
  return { ok: filledContracts > 0, orderId: "o", filledContracts, avgPriceCents: priceCents, status: filledContracts > 0 ? "partial" : "unfilled" };
}

describe("execution fill accounting", () => {
  it("never substitutes requested size for a zero fill", () => {
    const summary = summarizeFills([planned(45), planned(50)], [fill(20, 45), fill(0, 50)]);
    expect(summary.legs.map((leg) => leg.size)).toEqual([20, 0]);
    expect(summary.status).toBe("naked");
    expect(summary.totalCost).toBe(9);
    expect(summary.expectedProfit).toBeLessThan(0);
  });

  it("marks unequal nonzero fills as directional partial exposure", () => {
    const summary = summarizeFills([planned(45), planned(50)], [fill(20, 45), fill(10, 50)]);
    expect(summary.status).toBe("partial");
    expect(summary.reasonCode).toBe("naked_position");
    expect(summary.totalCost).toBe(14);
  });

  it("paper execution fills the refreshed FOK size without random slippage", async () => {
    const request = {
      venueId: "kalshi",
      marketId: "kalshi:1:total:6.5:over",
      outcome: "over",
      sizeContracts: 20,
      limitPriceCents: 45,
    };
    const result = await new DryRunAdapter("kalshi").placeOrder(request);
    expect(result).toMatchObject({ ok: true, filledContracts: 20, avgPriceCents: 45, status: "filled" });
  });
});
