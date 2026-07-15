import { afterEach, describe, expect, it } from "vitest";
import { resolveExecutionMode, type GateInput } from "./config";

// The gate must FAIL CLOSED: live only when every independent switch passes.
const base: GateInput = {
  requestedMode: "live",
  agentPaper: false,
  agentLive: true,
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

  it("blocks live for paper agent, disabled live switch, kill switch, or over the stake cap", () => {
    armEnv();
    expect(resolveExecutionMode({ ...base, agentPaper: true }).mode).toBe("dry_run");
    expect(resolveExecutionMode({ ...base, agentLive: false }).mode).toBe("dry_run");
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
