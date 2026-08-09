import { describe, expect, it } from "vitest";
import { resolveExecutionMode, type GateInput } from "./config";
import { fragileVenueFirstOrder, shouldSequenceFragileVenuePair } from "./executor";
import type { OrderRequest } from "./types";

// The gate must FAIL CLOSED: live only when every independent (UI-driven) switch passes.
// No environment variables — arming is the agent Live toggle + per-venue credentials.
// NOTE: maxLiveStakeUsd/stakeUsd are carried on GateInput but deliberately NOT enforced
// (see config.ts's header comment) — the field stays on the type for a future re-enable.
const base: GateInput = {
  requestedMode: "live",
  agentPaper: false,
  agentLive: true,
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
      stakeUsd: 999,
    });
    expect(d.mode).toBe("dry_run");
    expect(d.blocked).toBe(false);
    expect(d.blockers).toEqual([]);
  });

  it("BLOCKS live (no paper fallback) for a paper agent or disabled live switch", () => {
    expect(resolveExecutionMode({ ...base, agentPaper: true }).blocked).toBe(true);
    expect(resolveExecutionMode({ ...base, agentLive: false }).blocked).toBe(true);
  });

  it("does NOT block on stake size, regardless of maxLiveStakeUsd — bypassed by design", () => {
    const d = resolveExecutionMode({ ...base, stakeUsd: 50, maxLiveStakeUsd: 5 });
    expect(d.blocked).toBe(false);
    expect(d.blockers).toEqual([]);
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
    const d = resolveExecutionMode({ ...base, agentLive: false });
    expect(d.mode).toBe("live");
    expect(d.blocked).toBe(true);
  });

  it("reports ALL failing switches at once", () => {
    const d = resolveExecutionMode({
      ...base,
      agentLive: false,
      agentPaper: true,
      venues: ["kalshi", "polymarket"],
      venuesSupportLive: { kalshi: true, polymarket: false },
    });
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

  it("does NOT sequence predict.fun + kalshi (no SX.bet) — fires concurrently", () => {
    // Sequencing non-SX pairs was net-negative once Polymarket started filling reliably —
    // the confirmation wait before the second leg's turn is what caused naked fills, not
    // any single venue's reliability. See executor.ts's fragileVenueFirstOrder comment.
    const requests = [req("kalshi"), req("predictfun")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(false);
  });

  it("does NOT sequence Polymarket + predict.fun (no SX.bet) — fires concurrently", () => {
    const requests = [req("predictfun"), req("polymarket")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(false);
  });

  it("places sx.bet before kalshi (fragile on-chain leg first) so an sx.bet rejection skips the kalshi hedge", () => {
    const requests = [req("sxbet"), req("kalshi")];
    expect(shouldSequenceFragileVenuePair(requests)).toBe(true);
    expect(fragileVenueFirstOrder(requests)).toEqual([0, 1]);
  });
});
