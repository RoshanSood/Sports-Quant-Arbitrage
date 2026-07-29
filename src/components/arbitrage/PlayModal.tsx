"use client";

import { useState } from "react";
import { Play, Loader2, TriangleAlert } from "lucide-react";
import type { ArbOpportunity } from "@/types/arbitrage";
import { formatCents, formatDollars, formatEdgePct, formatOdds, venueDisplayName, venueStyle } from "./arbFormat";

type ExecResponse = {
  result?: string;
  reason?: string;
  mode?: "dry_run" | "live";
  blocked?: boolean;
  blockers?: string[];
  error?: string;
} | null;

export default function PlayModal({
  opp,
  onClose,
  onExecute,
}: {
  opp: ArbOpportunity;
  onClose: () => void;
  onExecute: (opp: ArbOpportunity, mode: "paper" | "live") => Promise<ExecResponse>;
}) {
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<ExecResponse>(null);

  async function confirm() {
    setSubmitting(true);
    setOutcome(null);
    try {
      const res = await onExecute(opp, mode);
      if (mode === "paper" && (res?.result === "executed" || res?.result === "partial")) {
        onClose();
        return;
      }
      // Live (or a paper failure): keep the modal open and show what actually happened —
      // especially the gate blockers when a live request was blocked (FAILED, not papered).
      setOutcome(res ?? { error: "no response" });
    } finally {
      setSubmitting(false);
    }
  }

  // Any non-success result is a failure we surface loudly (a live request is never
  // silently downgraded to paper). `blocked` = the live gate refused it.
  const failed = outcome != null && (Boolean(outcome.error) || outcome.result === "halted" || outcome.result === "failed" || outcome.result === "naked");

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-md rounded-xl border shadow-2xl"
        style={{ background: "#12151d", borderColor: "#2a2d35" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b" style={{ borderColor: "#2a2d35" }}>
          <h2 className="text-sm font-bold text-white">Execute arbitrage — {opp.matchup}</h2>
          <p className="text-[11px] text-gray-500">Both legs fired in parallel, then reconciled</p>
        </div>

        <div className="p-5 space-y-3 text-xs">
          {/* Paper / Live selector */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-lg" style={{ background: "#0b0d11" }}>
            {(["paper", "live"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setOutcome(null); }}
                className="py-1.5 rounded text-[11px] font-semibold capitalize transition-colors"
                style={
                  mode === m
                    ? { background: m === "live" ? "#3b0d0d" : "#1e2a3b", color: m === "live" ? "#fca5a5" : "#93c5fd" }
                    : { color: "#6b7280" }
                }
              >
                {m === "live" ? "Live (real money)" : "Paper"}
              </button>
            ))}
          </div>

          {opp.legs.map((leg, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
              <div>
                <div className="font-semibold" style={{ color: venueStyle(leg.venueId).text }}>
                  {venueDisplayName(leg.venueId)}
                </div>
                <div className="text-gray-400">{leg.label}</div>
              </div>
              <div className="text-right">
                <div className="text-gray-300">{formatOdds(leg.decimalOdds)} ({formatCents(leg.priceCents)})</div>
                <div className="text-[10px] text-gray-500">{leg.size} contracts · {formatDollars(opp.stakePlan.legSizes[leg.venueId] ?? 0)}</div>
              </div>
            </div>
          ))}

          <div className="grid grid-cols-3 gap-2 pt-1">
            <Metric label="Total cost" value={formatDollars(opp.stakePlan.totalStake)} />
            <Metric label="Net edge" value={`+${formatEdgePct(opp.netEdge)}`} accent="#34d399" />
            <Metric label="Est. profit" value={formatDollars(opp.stakePlan.expectedProfit)} accent="#34d399" />
          </div>

          {mode === "live" && (
            <div className="rounded-lg border px-3 py-2 space-y-2" style={{ borderColor: "#3b1717", background: "#160c0c" }}>
              <div className="flex items-start gap-1.5 text-[10px] text-red-300">
                <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                <span>
                  Real money. This passes through the execution gate — it runs live only if the agent&apos;s
                  Live toggle is on, the kill switch is off, the stake is under the Risk cap, and each venue has
                  credentials. If any check fails the trade is reported <strong>FAILED with the reason</strong> — it
                  will <strong>not</strong> run as a paper trade.
                </span>
              </div>
            </div>
          )}

          {outcome && (
            <div
              className="rounded-lg border px-3 py-2 text-[11px] space-y-1"
              style={{ borderColor: "#1e2130", background: "#0e1014" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Result</span>
                <span className="font-semibold" style={{ color: failed ? "#f87171" : "#4ade80" }}>
                  {outcome.error ? "FAILED" : failed ? `FAILED · ${outcome.result}` : `${outcome.result ?? "?"} · ${outcome.mode ?? "?"}`}
                </span>
              </div>
              {outcome.reason && <p className={failed ? "text-red-300" : "text-gray-500"}>{outcome.reason}</p>}
              {outcome.error && <p className="text-red-400">{outcome.error}</p>}
              {failed && outcome.blockers?.length ? (
                <div className="pt-1">
                  <p className="text-[10px] text-red-400">
                    {outcome.blocked ? "Live execution blocked — reasons:" : "Reasons:"}
                  </p>
                  <ul className="list-disc list-inside text-[10px] text-gray-400">
                    {outcome.blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: "#2a2d35" }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-white">Close</button>
          <button
            onClick={confirm}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40"
            style={{ background: mode === "live" ? "#dc2626" : "#d946ef" }}
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {mode === "live" ? "Execute LIVE trade" : "Confirm paper trade"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border px-2 py-1.5 text-center" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
      <div className="text-[9px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-sm font-bold" style={{ color: accent ?? "#f0f0f0" }}>{value}</div>
    </div>
  );
}
