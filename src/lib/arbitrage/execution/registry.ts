// Adapter registry. Dry-run mode always yields the simulator; live mode yields the
// venue's real adapter (which still refuses without credentials/native ids). Kalshi
// credentials may be passed per-call (forwarded from the user's browser) or come from
// the server env.

import type { KalshiCreds } from "@/lib/kalshiAuth";
import type { ExecMode } from "./config";
import { polymarketRegion } from "@/lib/polymarketRegion";
import { DryRunAdapter } from "./dryRunAdapter";
import { KalshiExecutionAdapter } from "./kalshiAdapter";
import type { OnchainCreds } from "./onchainCreds";
import { PolymarketUsExecutionAdapter } from "./polymarketUsAdapter";
import { PredictFunExecutionAdapter } from "./predictFunAdapter";
import { PolymarketExecutionAdapter, SxBetExecutionAdapter } from "./onchainAdapters";
import type { ExecutionAdapter } from "./types";

// Per-request credentials forwarded from the browser (UI-entered) or falling back to
// server env inside each adapter. Wallet keys are used transiently, never persisted.
export type ExecCreds = { kalshiCreds?: KalshiCreds } & OnchainCreds;

export function liveAdapter(venueId: string, creds?: ExecCreds): ExecutionAdapter {
  const v = venueId.toLowerCase();
  if (v.includes("kalshi")) return new KalshiExecutionAdapter(creds?.kalshiCreds);
  if (v.includes("poly")) {
    return polymarketRegion() === "us"
      ? new PolymarketUsExecutionAdapter(creds?.polymarket)
      : new PolymarketExecutionAdapter(creds?.polymarket);
  }
  if (v.includes("sx")) return new SxBetExecutionAdapter(creds?.sxbet);
  if (v.includes("predict")) return new PredictFunExecutionAdapter();
  return new DryRunAdapter(venueId); // unknown venue can never go live
}

export function getAdapter(venueId: string, mode: ExecMode, creds?: ExecCreds): ExecutionAdapter {
  return mode === "live" ? liveAdapter(venueId, creds) : new DryRunAdapter(venueId);
}

// Which venues currently have a working live adapter (feeds the gate).
export function venueSupportsLive(venues: string[], creds?: ExecCreds): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const v of venues) out[v] = liveAdapter(v, creds).supportsLive();
  return out;
}
