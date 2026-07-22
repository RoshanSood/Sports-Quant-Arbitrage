"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { RiskSettings } from "@/types/arbitrage";
import { FloatingPanel } from "./ui";
import { formatDollars, formatEdgePct, formatSignedDollars } from "./arbFormat";

export default function RiskPanel({
  risk,
  killSwitch,
  onToggleKill,
  onUpdateRisk,
  agentLive,
  autoTrade,
  onClose,
}: {
  risk: RiskSettings;
  killSwitch: boolean;
  onToggleKill: (v: boolean) => void;
  onUpdateRisk: (partial: Partial<RiskSettings>) => void;
  agentLive: boolean;
  autoTrade: boolean;
  onClose: () => void;
}) {
  const exposurePct = risk.maxExposure > 0 ? Math.min(1, risk.currentExposure / risk.maxExposure) : 0;
  const [stakeInput, setStakeInput] = useState(String(risk.maxLiveStakeUsd ?? 5));

  // Set the cap to an exact value: clamp to ≥ 0, reflect it in the field, and persist if
  // it actually changed. Shared by the field, the −/+ steppers, and the quick-set chips.
  function applyStake(n: number) {
    const v = Math.max(0, Math.round(n));
    setStakeInput(String(v));
    if (v !== risk.maxLiveStakeUsd) onUpdateRisk({ maxLiveStakeUsd: v });
  }
  function commitStake() {
    const n = Number(stakeInput);
    if (Number.isFinite(n) && n >= 0) applyStake(n);
    else setStakeInput(String(risk.maxLiveStakeUsd ?? 5)); // revert a bad entry
  }
  function step(delta: number) {
    const base = Number(stakeInput);
    applyStake((Number.isFinite(base) ? base : risk.maxLiveStakeUsd ?? 5) + delta);
  }

  const STAKE_PRESETS = [5, 10, 25, 50, 100];

  // Max concurrent open positions on the SAME arb (match + line). 0 = unlimited — you can
  // re-enter as long as fresh quotes still show edge + depth.
  function setMaxOpen(n: number) {
    const v = Math.max(0, Math.round(n));
    if (v !== risk.maxOpenPositions) onUpdateRisk({ maxOpenPositions: v });
  }
  const maxOpen = risk.maxOpenPositions ?? 1;

  // Auto-execution is LIVE (real money, no click) when auto-trade and the agent Live
  // toggle are both on. Every order still passes the server gate and risk cap.
  const autoLiveArmed = autoTrade && agentLive;

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

      {/* Live stake cap — the hard per-trade $ ceiling on REAL orders (UI-configured). */}
      <div className="rounded-lg border px-3 py-2.5 mb-4" style={{ borderColor: "#3f2d10", background: "#1a160e" }}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-amber-300">Max live stake</div>
            <div className="text-[10px] text-gray-500">Hard cap on $ per real trade — keep low until validated</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={Number(stakeInput) <= 0}
              aria-label="Decrease max live stake by $1"
              className="w-8 h-8 rounded flex items-center justify-center text-lg font-bold leading-none text-amber-200 hover:bg-[#332711] disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: "#241c10", border: "1px solid #3a2f17" }}
            >
              −
            </button>
            <div className="flex items-center gap-0.5">
              <span className="text-gray-400 text-sm">$</span>
              <input
                type="number"
                min={0}
                step={1}
                value={stakeInput}
                onChange={(e) => setStakeInput(e.target.value)}
                onBlur={commitStake}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="w-16 rounded bg-[#0b0d11] border px-2 py-1 text-sm text-right text-gray-100"
                style={{ borderColor: "#3a2f17" }}
              />
            </div>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Increase max live stake by $1"
              className="w-8 h-8 rounded flex items-center justify-center text-lg font-bold leading-none text-amber-200 hover:bg-[#332711]"
              style={{ background: "#241c10", border: "1px solid #3a2f17" }}
            >
              +
            </button>
          </div>
        </div>

        {/* Quick-set presets */}
        <div className="flex items-center flex-wrap gap-1.5 mt-2.5">
          <span className="text-[10px] text-gray-500 mr-0.5">Quick set</span>
          {STAKE_PRESETS.map((v) => {
            const active = risk.maxLiveStakeUsd === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => applyStake(v)}
                className="px-2 py-0.5 rounded text-[11px] font-semibold transition-colors"
                style={
                  active
                    ? { background: "#3f2d10", color: "#fcd34d", border: "1px solid #b45309" }
                    : { background: "#0b0d11", color: "#9ca3af", border: "1px solid #2a2f3e" }
                }
              >
                ${v}
              </button>
            );
          })}
        </div>
      </div>

      {/* Max open positions per arb — set Unlimited to stack multiple bets on one game. */}
      <div className="rounded-lg border px-3 py-2.5 mb-4" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-gray-200">Max open per match</div>
            <div className="text-[10px] text-gray-500">Concurrent positions on the same arb (line). Each re-entry still re-checks edge + depth.</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setMaxOpen(maxOpen - 1)}
              disabled={maxOpen <= 0}
              aria-label="Decrease max open per match"
              className="w-8 h-8 rounded flex items-center justify-center text-lg font-bold leading-none text-gray-200 hover:bg-[#1a1d24] disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: "#12151b", border: "1px solid #2a2f3e" }}
            >
              −
            </button>
            <span className="w-10 text-center text-sm font-bold text-gray-100">{maxOpen === 0 ? "∞" : maxOpen}</span>
            <button
              type="button"
              onClick={() => setMaxOpen(maxOpen + 1)}
              aria-label="Increase max open per match"
              className="w-8 h-8 rounded flex items-center justify-center text-lg font-bold leading-none text-gray-200 hover:bg-[#1a1d24]"
              style={{ background: "#12151b", border: "1px solid #2a2f3e" }}
            >
              +
            </button>
          </div>
        </div>
        <div className="flex items-center flex-wrap gap-1.5 mt-2.5">
          <span className="text-[10px] text-gray-500 mr-0.5">Quick set</span>
          {[1, 3, 5, 0].map((v) => {
            const active = maxOpen === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setMaxOpen(v)}
                className="px-2 py-0.5 rounded text-[11px] font-semibold transition-colors"
                style={active ? { background: "#1e2a3b", color: "#93c5fd", border: "1px solid #2563eb" } : { background: "#0b0d11", color: "#9ca3af", border: "1px solid #2a2f3e" }}
              >
                {v === 0 ? "Unlimited" : v}
              </button>
            );
          })}
        </div>
      </div>

      {/* Live auto-execute — real money, no click. Armed only with all three switches. */}
      <div className="rounded-lg border px-3 py-2.5 mb-4" style={{ borderColor: autoLiveArmed ? "#3b1717" : "#1e2130", background: autoLiveArmed ? "#160c0c" : "#0e1014" }}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-semibold" style={{ color: autoLiveArmed ? "#fca5a5" : "#9ca3af" }}>Live auto-execute</div>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={autoLiveArmed ? { background: "#7f1d1d", color: "#fecaca" } : { background: "#1f2937", color: "#9ca3af" }}>
            {autoLiveArmed ? "ARMED — REAL MONEY" : "off"}
          </span>
        </div>
        <p className="text-[10px] text-gray-500 mb-1.5">
          Fires trades automatically with no click. Needs auto-trade ON and the agent&apos;s Live toggle ON.
          Every trade still passes the gate + the ${risk.maxLiveStakeUsd} cap above.
        </p>
        <div className="text-[10px] mt-1 text-gray-500">
          {!autoTrade ? "Turn on auto-trade (top bar) to enable." : !agentLive ? "Turn on the agent's Live toggle (Settings) to go live - otherwise auto-trade is paper." : "Armed: real trades will fire automatically."}
        </div>
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
          <Cell label="Min Liquidity" value={`$${risk.minLiquidityUsd ?? 0}`} />
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
