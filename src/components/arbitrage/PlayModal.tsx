"use client";

import { useState } from "react";
import { Play, Loader2 } from "lucide-react";
import type { ArbOpportunity } from "@/types/arbitrage";
import { formatCents, formatDollars, formatEdgePct, formatOdds } from "./arbFormat";

export default function PlayModal({
  opp,
  onClose,
  onConfirm,
}: {
  opp: ArbOpportunity;
  onClose: () => void;
  onConfirm: (opp: ArbOpportunity) => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    setSubmitting(true);
    try {
      await onConfirm(opp);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

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
          <p className="text-[11px] text-gray-500">Paper mode · both legs fired in parallel after checks</p>
        </div>

        <div className="p-5 space-y-3 text-xs">
          {opp.legs.map((leg, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
              <div>
                <div className="font-semibold capitalize" style={{ color: leg.venueId.includes("kalshi") ? "#60a5fa" : "#c4b5fd" }}>
                  {leg.venueId}
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
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: "#2a2d35" }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={confirm}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-60"
            style={{ background: "#d946ef" }}
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Confirm paper trade
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
