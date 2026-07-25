import { describe, expect, it } from "vitest";
import { resolveExecutionMode, type GateInput } from "./config";
import { fragileVenueFirstOrder, shouldSequenceFragileVenuePair } from "./executor";
import type { OrderRequest } from "./types";

// The gate must FAIL CLOSED: live only when every independent (UI-driven) switch passes.
// No environment variables — arming is the agent Live toggle + risk kill switch + risk
// stake cap + per-venue credentials.
const base: GateInput = {
  requestedMode: "live",
  agentPaper: false,
  agentLive: true,
  killSwitch: false,
  venues: ["kalshi"],
  stakeUsd: 1,
  maxLiveStakeUsd: 5,
  venuesSupportLive: { kalshi: true },
};

describe("execution safety gate (UI-driven)", () => {
  it("goes live only when EVERY switch passes", () => {
    const d = resolveExecutionMode(base);
    expect(d.mode).toBe("live");
    expect(d.blocked).toBe(false);
    expect(d.blockers).toEqual([]);
  });

  it("stays dry_run (never blocked) when the caller requested paper", () => {
    const d = resolveExecutionMode({ ...base, requestedMode: "dry_run" });
    expect(d.mode).toBe("dry_run");
    expect(d.blocked).toBe(false);
  });

  it("a paper request ignores the live switches — always simulates, never blocked", () => {
    const d = resolveExecutionMode({
      ...base,
      requestedMode: "dry_run",
      agentPaper: true,
      agentLive: false,
      killSwitch: true,
      stakeUsd: 999,
    });
    expect(d.mode).toBe("dry_run");
    expect(d.blocked).toBe(false);
    expect(d.blockers).toEqual([]);
  });

  it("BLOCKS live (no paper fallback) for paper agent, disabled live switch, or kill switch", () => {
    expect(resolveExecutionMode({ ...base, agentPaper: true }).blocked).toBe(true);
    expect(resolveExecutionMode({ ...base, agentLive: false }).blocked).toBe(true);
    expect(resolveExecutionMode({ ...base, killSwitch: true }).blocked).toBe(true);
  });

  it("blocks live when stake exceeds the risk-panel cap", () => {
    const d = resolveExecutionMode({ ...base, stakeUsd: 50, maxLiveStakeUsd: 5 });
    expect(d.blocked).toBe(true);
    expect(d.blockers.some((b) => b.includes("exceeds live cap"))).toBe(true);
  });

  it("blocks live when a venue has no credentials/signer", () => {
    const d = resolveExecutionMode({
      ...base,
      venues: ["kalshi", "polymarket"],
      venuesSupportLive: { kalshi: true, polymarket: false },
    });
    expect(d.blocked).toBe(true);
    expect(d.blockers.some((b) => b.includes("polymarket"))).toBe(true);
  });

  it("a blocked live request keeps mode 'live' (intent) — the executor FAILS it, not paper", () => {
    const d = resolveExecutionMode({ ...base, killSwitch: true });
    expect(d.mode).toBe("live");
    expect(d.blocked).toBe(true);
  });

  it("reports ALL failing switches at once", () => {
    const d = resolveExecutionMode({ ...base, agentLive: false, killSwitch: true, stakeUsd: 999 });
    expect(d.blocked).toBe(true);
    expect(d.blockers.length).toBeGreaterThanOrEqual(3);
  });
});

describe("live execution sequencing", () => {
  const req = (venueId: string): OrderRequest => ({
    venueId,
    marketId: `${venueId}-market`,
    outcome: "home",
    sizeContracts: 2,
    limitPriceCents: 50,
  });

  it("places predict.fun before kalshi so a predict.fun reject cannot leave a kalshi-only fill", () => {
    const requests = [req("kalshi"), req("predictfun")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(true);
    expect(fragileVenueFirstOrder(requests)).toEqual([1, 0]);
  });
});
