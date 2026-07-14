// Execution safety gate (manual §18). Real orders are OFF by default at every layer.
// A leg only reaches a venue with real money when EVERY independent switch is on:
//
//   1. ARB_EXECUTION_MODE=live         (global env kill switch, default dry_run)
//   2. the leg's venue is in ARB_LIVE_VENUES allowlist (env, default empty)
//   3. the caller explicitly requested mode "live"
//   4. the agent is NOT paper (agent.paper === false)
//   5. the risk kill switch is OFF
//   6. total stake ≤ ARB_MAX_LIVE_STAKE_USD (env, small default)
//   7. the venue adapter reports supportsLive() (credentials/signer configured)
//
// If any switch is off, execution falls back to DRY-RUN (simulated) — never a real
// order. This module owns switches 1, 2, 6.

export type ExecMode = "dry_run" | "live";

// Global mode. Anything other than the exact string "live" is dry-run.
export function getExecutionMode(): ExecMode {
  return process.env.ARB_EXECUTION_MODE === "live" ? "live" : "dry_run";
}

// Comma-separated venue allowlist, e.g. ARB_LIVE_VENUES="kalshi,polymarket".
export function liveVenueAllowlist(): Set<string> {
  return new Set(
    (process.env.ARB_LIVE_VENUES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isVenueLiveAllowed(venueId: string): boolean {
  return liveVenueAllowlist().has(venueId.toLowerCase());
}

// Hard cap on the dollars any single live trade may commit. Defaults low on purpose;
// validate the whole path at a few dollars before ever raising this.
export function maxLiveStakeUsd(): number {
  const v = Number(process.env.ARB_MAX_LIVE_STAKE_USD);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

export type GateInput = {
  requestedMode: ExecMode;
  agentPaper: boolean;
  killSwitch: boolean;
  venues: string[];
  stakeUsd: number;
  venuesSupportLive: Record<string, boolean>;
};

export type GateDecision = { mode: ExecMode; blockers: string[] };

// Resolve the EFFECTIVE execution mode. Returns "live" only when all switches pass;
// otherwise "dry_run" with the list of blockers (for logging/UI transparency).
export function resolveExecutionMode(g: GateInput): GateDecision {
  const blockers: string[] = [];
  if (g.requestedMode !== "live") blockers.push("caller did not request live");
  if (getExecutionMode() !== "live") blockers.push("ARB_EXECUTION_MODE is not 'live'");
  if (g.agentPaper) blockers.push("agent is in paper mode");
  if (g.killSwitch) blockers.push("risk kill switch is on");
  if (g.stakeUsd > maxLiveStakeUsd()) blockers.push(`stake $${g.stakeUsd} exceeds live cap $${maxLiveStakeUsd()}`);
  for (const v of g.venues) {
    if (!isVenueLiveAllowed(v)) blockers.push(`venue ${v} not in ARB_LIVE_VENUES allowlist`);
    if (!g.venuesSupportLive[v]) blockers.push(`venue ${v} adapter has no live credentials/signer`);
  }
  return { mode: blockers.length === 0 ? "live" : "dry_run", blockers };
}
