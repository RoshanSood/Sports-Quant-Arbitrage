// Adapter registry. Dry-run mode always yields the simulator; live mode yields the
// venue's real adapter (which still refuses without credentials/native ids). Kalshi
// credentials may be passed per-call (forwarded from the user's browser) or come from
// the server env.

import type { KalshiCreds } from "@/lib/kalshiAuth";
import type { ExecMode } from "./config";
import { DryRunAdapter } from "./dryRunAdapter";
import { KalshiExecutionAdapter } from "./kalshiAdapter";
import { PolymarketExecutionAdapter, SxBetExecutionAdapter } from "./onchainAdapters";
import type { ExecutionAdapter } from "./types";

export type ExecCreds = { kalshiCreds?: KalshiCreds };

export function liveAdapter(venueId: string, creds?: ExecCreds): ExecutionAdapter {
  const v = venueId.toLowerCase();
  if (v.includes("kalshi")) return new KalshiExecutionAdapter(creds?.kalshiCreds);
  if (v.includes("poly")) return new PolymarketExecutionAdapter();
  if (v.includes("sx")) return new SxBetExecutionAdapter();
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
