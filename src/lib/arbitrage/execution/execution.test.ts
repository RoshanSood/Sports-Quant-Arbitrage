import { describe, expect, it } from "vitest";
import { resolveExecutionMode, type GateInput } from "./config";

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
    expect(d.blockers).toEqual([]);
  });

  it("stays dry_run if the caller only requested dry_run", () => {
    expect(resolveExecutionMode({ ...base, requestedMode: "dry_run" }).mode).toBe("dry_run");
  });

  it("blocks live for paper agent, disabled live switch, or kill switch", () => {
    expect(resolveExecutionMode({ ...base, agentPaper: true }).mode).toBe("dry_run");
    expect(resolveExecutionMode({ ...base, agentLive: false }).mode).toBe("dry_run");
    expect(resolveExecutionMode({ ...base, killSwitch: true }).mode).toBe("dry_run");
  });

  it("blocks live when stake exceeds the risk-panel cap", () => {
    const d = resolveExecutionMode({ ...base, stakeUsd: 50, maxLiveStakeUsd: 5 });
    expect(d.mode).toBe("dry_run");
    expect(d.blockers.some((b) => b.includes("exceeds live cap"))).toBe(true);
  });

  it("blocks live when a venue has no credentials/signer", () => {
    const d = resolveExecutionMode({
      ...base,
      venues: ["kalshi", "polymarket"],
      venuesSupportLive: { kalshi: true, polymarket: false },
    });
    expect(d.mode).toBe("dry_run");
    expect(d.blockers.some((b) => b.includes("polymarket"))).toBe(true);
  });

  it("reports ALL failing switches at once", () => {
    const d = resolveExecutionMode({ ...base, agentLive: false, killSwitch: true, stakeUsd: 999 });
    expect(d.mode).toBe("dry_run");
    expect(d.blockers.length).toBeGreaterThanOrEqual(3);
  });
});
