// Execution safety gate. Arming is fully UI-driven — no environment variables. Real
// orders are still OFF by default because a fresh agent seeds paper:true / live:false.
// A leg only reaches a venue with real money when EVERY independent switch is on:
//
//   1. the caller explicitly requested mode "live"        (the "Live" button in Play)
//   2. the agent is NOT paper (agent.paper === false)      (Settings toggle)
//   3. the agent's live switch is ON (agent.live === true) (Settings toggle)
//   4. the risk kill switch is OFF                          (Risk panel)
//   5. total stake ≤ the risk panel's max live stake        (Risk panel, UI-configured)
//   6. the venue adapter reports supportsLive() (credentials/signer entered in the UI)
//
// A LIVE request that fails any switch is BLOCKED (blocked:true) — the executor reports
// FAILED with the reasons and places NO order. It does NOT silently fall back to paper.
// Paper (dry-run/simulated) only happens when the caller explicitly requests paper mode.

export type ExecMode = "dry_run" | "live";

// Default per-trade live cap (dollars) used to SEED risk settings on first run. After
// that it's edited in the Risk panel (UI), not here — kept low on purpose so the whole
// path is validated at a few dollars before the cap is ever raised.
export const DEFAULT_MAX_LIVE_STAKE_USD = 13;

export type GateInput = {
  requestedMode: ExecMode;
  agentPaper: boolean;
  agentLive: boolean;
  killSwitch: boolean;
  venues: string[];
  stakeUsd: number;
  maxLiveStakeUsd: number; // from risk settings (UI-configured)
  ignoreLiveStakeCap?: boolean;
  venuesSupportLive: Record<string, boolean>;
};

// `blocked` = a LIVE request that can't fire. When true the executor FAILS the trade with
// `blockers` and places nothing (no paper fallback). `mode` is the intent: "dry_run" for an
// explicit paper request (always runs simulated), "live" for a live request (runs only when
// blocked === false).
export type GateDecision = { mode: ExecMode; blocked: boolean; blockers: string[] };

// Resolve the execution decision.
//   • Paper request (requestedMode !== "live") → simulate. Never blocked.
//   • Live request → live ONLY when every switch passes; otherwise blocked (FAIL, no paper).
export function resolveExecutionMode(g: GateInput): GateDecision {
  // An explicit paper request always simulates — the live switches don't apply.
  if (g.requestedMode !== "live") return { mode: "dry_run", blocked: false, blockers: [] };

  const blockers: string[] = [];
  if (g.agentPaper) blockers.push("agent is in paper mode (turn on Live in agent settings)");
  if (!g.agentLive) blockers.push("agent live execution switch is off");
  if (g.killSwitch) blockers.push("risk kill switch is on");
  if (!g.ignoreLiveStakeCap && g.stakeUsd > g.maxLiveStakeUsd) blockers.push(`stake $${g.stakeUsd} exceeds live cap $${g.maxLiveStakeUsd}`);
  for (const v of g.venues) {
    if (!g.venuesSupportLive[v]) blockers.push(`venue ${v} has no live credentials/signer`);
  }
  return { mode: "live", blocked: blockers.length > 0, blockers };
}
