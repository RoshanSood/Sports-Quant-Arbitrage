"use client";

import { ShieldAlert } from "lucide-react";
import type { RiskSettings } from "@/types/arbitrage";
import { FloatingPanel } from "./ui";
import { formatDollars, formatEdgePct, formatSignedDollars } from "./arbFormat";

export default function RiskPanel({
  risk,
  killSwitch,
  onToggleKill,
  onClose,
}: {
  risk: RiskSettings;
  killSwitch: boolean;
  onToggleKill: (v: boolean) => void;
  onClose: () => void;
}) {
  const exposurePct = risk.maxExposure > 0 ? Math.min(1, risk.currentExposure / risk.maxExposure) : 0;

  return (
    <FloatingPanel title="Risk" onClose={onClose} width="max-w-md">
      <div className="rounded-lg border px-4 py-3 mb-4 text-[11px] leading-relaxed" style={{ borderColor: "#7f1d1d", background: "#1a0e0e", color: "#fca5a5" }}>
        NOTICE: Claw Arbs is provided &quot;as is&quot; without warranty. The developer is not responsible for
        trading losses, execution failures, naked exposure, API outages, venue actions, or any other financial
        loss. You trade at your own risk.
      </div>

      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-semibold text-white">Kill Switch</span>
        <button
          onClick={() => onToggleKill(!killSwitch)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold text-white"
          style={{ background: killSwitch ? "#dc2626" : "#374151" }}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          {killSwitch ? "ARMED — STOP ALL" : "KILL SWITCH"}
        </button>
      </div>

      <div className="space-y-3 text-xs">
        <Row label="Exposure (paper bankroll)">
          <span className="text-gray-300">
            {formatDollars(risk.currentExposure)} / {formatDollars(risk.maxExposure)}
          </span>
        </Row>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: "#1e2130" }}>
          <div className="h-full rounded-full" style={{ width: `${exposurePct * 100}%`, background: exposurePct > 0.8 ? "#f87171" : "#22c55e" }} />
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <Cell label="Daily P&L" value={formatSignedDollars(risk.dailyPnl)} accent={risk.dailyPnl >= 0 ? "#34d399" : "#f87171"} />
          <Cell label="Max Daily Loss" value={formatDollars(risk.maxDailyLoss)} />
          <Cell label="Max Open Positions" value={String(risk.maxOpenPositions)} />
          <Cell label="Pause on Naked" value={risk.pauseOnNaked ? "On" : "Off"} />
          <Cell label="Stale Quote Age" value={`${risk.staleQuoteMs} ms`} />
          <Cell label="Status" value={killSwitch ? "HALTED" : "OK"} accent={killSwitch ? "#f87171" : "#34d399"} />
        </div>
        <p className="text-[10px] text-gray-500 pt-2">
          Min edge {formatEdgePct(0.005)} · Max edge {formatEdgePct(0.25)} (default agent). Edges above cap are
          often stale or mismatched.
        </p>
      </div>
    </FloatingPanel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      {children}
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-sm font-bold" style={{ color: accent ?? "#f0f0f0" }}>{value}</div>
    </div>
  );
}
