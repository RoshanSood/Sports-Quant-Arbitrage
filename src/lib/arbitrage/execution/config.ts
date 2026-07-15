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
// If any switch is off, execution falls back to DRY-RUN (simulated) — never a real
// order — and reports the blockers for transparency.

export type ExecMode = "dry_run" | "live";

// Default per-trade live cap (dollars) used to SEED risk settings on first run. After
// that it's edited in the Risk panel (UI), not here — kept low on purpose so the whole
// path is validated at a few dollars before the cap is ever raised.
export const DEFAULT_MAX_LIVE_STAKE_USD = 5;

export type GateInput = {
  requestedMode: ExecMode;
  agentPaper: boolean;
  agentLive: boolean;
  killSwitch: boolean;
  venues: string[];
  stakeUsd: number;
  maxLiveStakeUsd: number; // from risk settings (UI-configured)
  venuesSupportLive: Record<string, boolean>;
};

export type GateDecision = { mode: ExecMode; blockers: string[] };

// Resolve the EFFECTIVE execution mode. Returns "live" only when all switches pass;
// otherwise "dry_run" with the list of blockers (for logging/UI transparency).
export function resolveExecutionMode(g: GateInput): GateDecision {
  const blockers: string[] = [];
  if (g.requestedMode !== "live") blockers.push("caller did not request live");
  if (g.agentPaper) blockers.push("agent is in paper mode");
  if (!g.agentLive) blockers.push("agent live execution switch is off");
  if (g.killSwitch) blockers.push("risk kill switch is on");
  if (g.stakeUsd > g.maxLiveStakeUsd) blockers.push(`stake $${g.stakeUsd} exceeds live cap $${g.maxLiveStakeUsd}`);
  for (const v of g.venues) {
    if (!g.venuesSupportLive[v]) blockers.push(`venue ${v} has no live credentials/signer`);
  }
  return { mode: blockers.length === 0 ? "live" : "dry_run", blockers };
}
