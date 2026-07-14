"use client";

import Link from "next/link";
import { ArrowLeft, Square, Radio, Volume2, RotateCcw, Bot } from "lucide-react";
import type { PanelKey } from "./ArbitrageClient";
import { formatSignedDollars } from "./arbFormat";

const NAV_BUTTONS: { key: PanelKey; label: string }[] = [
  { key: "arbs", label: "Arbs" },
  { key: "portfolio", label: "Portfolio" },
  { key: "matchmap", label: "Match Map" },
  { key: "risk", label: "Risk" },
  { key: "log", label: "Log" },
  { key: "analytics", label: "Analytics" },
];

export default function ClawArbsTopBar({
  scanning,
  soundOn,
  agentCount,
  pnl,
  killSwitch,
  autoTrade = false,
  onToggleScanning,
  onToggleSound,
  onToggleAuto,
  onOpenPanel,
  onOpenAgent,
  onReset,
}: {
  scanning: boolean;
  soundOn: boolean;
  agentCount: number;
  pnl: number;
  killSwitch: boolean;
  autoTrade?: boolean;
  onToggleScanning: () => void;
  onToggleSound: () => void;
  onToggleAuto?: () => void;
  onOpenPanel: (key: PanelKey) => void;
  onOpenAgent: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 h-12 border-b overflow-x-auto shrink-0" style={{ background: "#0b0d12", borderColor: "#1e2130" }}>
      <Link href="/" className="flex items-center gap-1 text-gray-500 hover:text-gray-300 text-xs mr-1 shrink-0">
        <ArrowLeft className="w-3.5 h-3.5" />
      </Link>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-emerald-400 font-bold text-sm leading-none">⁄⁄</span>
        <span className="text-white font-bold text-xs leading-tight">Claw<br />Arbs</span>
      </div>

      <button
        onClick={onToggleScanning}
        className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold text-white shrink-0"
        style={{ background: killSwitch ? "#7f1d1d" : scanning ? "#dc2626" : "#16a34a" }}
      >
        <Square className="w-3 h-3" fill="currentColor" />
        {killSwitch ? "Halted" : scanning ? "Stop" : "Start"}
      </button>

      <Chip active={scanning && !killSwitch} onClick={onToggleScanning} icon={<Radio className="w-3 h-3" />} label="Scanning" color="#22c55e" />
      <Chip active={autoTrade && !killSwitch} onClick={onToggleAuto ?? (() => {})} icon={<Bot className="w-3 h-3" />} label="Auto-trade" color="#d946ef" />
      <Chip active={soundOn} onClick={onToggleSound} icon={<Volume2 className="w-3 h-3" />} label="Sound" color="#eab308" />

      <span className="flex items-center gap-1 px-2 py-1 rounded text-[11px] shrink-0" style={{ background: "#12151d", color: "#9ca3af" }}>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {agentCount} agents
      </span>

      <div className="flex items-center gap-1 shrink-0">
        {NAV_BUTTONS.map((b) => (
          <button
            key={b.key}
            onClick={() => onOpenPanel(b.key)}
            className="px-2.5 py-1 rounded text-[11px] font-semibold text-gray-400 hover:text-white hover:bg-[#12151d]"
          >
            {b.label}
          </button>
        ))}
        <button onClick={onOpenAgent} className="px-2.5 py-1 rounded text-[11px] font-semibold text-gray-400 hover:text-white hover:bg-[#12151d]">
          Settings
        </button>
      </div>

      <div className="flex items-center gap-1 ml-auto shrink-0">
        <button onClick={onOpenAgent} className="px-2 py-1 rounded text-[11px] font-semibold text-white" style={{ background: "#059669" }}>+ Agent</button>
        <button onClick={() => onOpenPanel("arbs")} className="px-2 py-1 rounded text-[11px] font-semibold text-white" style={{ background: "#2563eb" }}>+ Venue</button>
        <button onClick={onReset} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-gray-300 border" style={{ borderColor: "#2a2d35" }}>
          <RotateCcw className="w-3 h-3" /> Reset
        </button>
        <span className="px-2 py-1 rounded text-[11px] font-bold" style={{ color: pnl >= 0 ? "#34d399" : "#f87171" }}>
          PnL: {formatSignedDollars(pnl)}
        </span>
      </div>
    </div>
  );
}

function Chip({ active, onClick, icon, label, color }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; color: string }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold shrink-0 transition-colors"
      style={{ background: active ? `${color}22` : "#12151d", color: active ? color : "#6b7280", border: `1px solid ${active ? `${color}55` : "#1e2130"}` }}
    >
      {icon}
      {label}
    </button>
  );
}
