"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import type { Agent, ArbLog } from "@/types/arbitrage";
import { Drawer, Toggle } from "./ui";
import { formatClock, formatEdgePct, reasonCodeLabel } from "./arbFormat";

export default function AgentDrawer({
  agent,
  logs,
  onChange,
  onClose,
}: {
  agent: Agent;
  logs: ArbLog[];
  onChange: (partial: Partial<Agent>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"settings" | "activity">("settings");
  const agentLogs = logs.filter((l) => l.agent === agent.id);

  return (
    <Drawer
      title={agent.name}
      subtitle="arb"
      onClose={onClose}
      header={
        <div className="flex border-b" style={{ borderColor: "#2a2d35" }}>
          {(["settings", "activity"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-xs font-semibold capitalize ${
                tab === t ? "text-white border-b-2 border-blue-500" : "text-gray-500"
              }`}
            >
              {t === "activity" ? `Activity (${agentLogs.length})` : "Settings"}
            </button>
          ))}
        </div>
      }
    >
      {tab === "settings" ? (
        <div className="p-4 space-y-4 text-xs">
          <SettingRow label="Enabled">
            <Toggle checked={agent.enabled} onChange={(v) => onChange({ enabled: v })} />
          </SettingRow>
          <SettingRow label="Paper Trading" hint="default">
            <Toggle checked={agent.paper} onChange={(v) => onChange({ paper: v })} />
          </SettingRow>
          <SettingRow label="Live Execution" hint="Locked · Alpha build">
            <span className="inline-flex items-center gap-1 text-gray-600">
              <Lock className="w-3 h-3" />
              <Toggle checked={agent.live} disabled />
            </span>
          </SettingRow>
          <SettingRow label="Auto-trade" hint="paper · fills arbs without a click">
            <Toggle checked={agent.autoTrade} onChange={(v) => onChange({ autoTrade: v })} />
          </SettingRow>
          {agent.autoTrade && (
            <p className="text-[10px] text-amber-400/80 -mt-2">
              Agent auto-fills qualifying paper arbs while Scanning is on. Turn off Scanning or the kill switch to stop.
            </p>
          )}

          <div>
            <div className="text-gray-400 mb-1">Strategy Type</div>
            <div className="flex gap-1">
              <button
                onClick={() => onChange({ strategy: "arbitrage" })}
                className={`px-3 py-1 rounded text-xs font-semibold ${agent.strategy === "arbitrage" ? "bg-emerald-600 text-white" : "text-gray-400 border border-[#2a2d35]"}`}
              >
                Arbitrage
              </button>
              <button
                disabled
                className="px-3 py-1 rounded text-xs font-semibold text-gray-600 border border-[#2a2d35] cursor-not-allowed"
              >
                Value Betting
              </button>
            </div>
            <p className="text-[10px] text-gray-600 mt-1">Determines which venue pairs this agent scans for arbitrage.</p>
          </div>

          <Section title="Edge Thresholds" defaultOpen>
            <p className="text-[10px] text-gray-500 mb-2">
              Edge % is the guaranteed profit margin on a trade, after fees. A 3% edge on a $50 bet = $1.50 profit.
            </p>
            <EdgeInput label="Min Edge" value={agent.minEdge} onChange={(v) => onChange({ minEdge: v })} />
            <EdgeInput label="Max Edge" value={agent.maxEdge} onChange={(v) => onChange({ maxEdge: v })} />
            <p className="text-[10px] text-gray-600 mt-1">
              Typical starting range: 1–2% min edge, 15–25% max edge. Edges are net of Kalshi fees and slippage.
            </p>
          </Section>

          <Section title="Position Sizing">
            <SettingRow label="Method"><span className="text-gray-300 capitalize">{agent.sizingMethod.replace("_", " ")}</span></SettingRow>
            <SettingRow label="Max Stake / Arb"><span className="text-gray-300">${agent.maxStake}</span></SettingRow>
          </Section>

          <Section title="Match Filters">
            <p className="text-[10px] text-gray-500">Game totals first, then moneylines and spreads. MLB only in this build.</p>
          </Section>

          <Section title="Execution">
            <SettingRow label="Stale Quote Age"><span className="text-gray-300">{agent.staleQuoteMs} ms</span></SettingRow>
            <SettingRow label="Venues"><span className="text-gray-300">{agent.venues.join(", ")}</span></SettingRow>
          </Section>
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {agentLogs.map((l) => (
            <div key={l.id} className="rounded-lg border px-3 py-2" style={{ borderColor: l.result === "executed" ? "#14532d" : "#7f1d1d", background: l.result === "executed" ? "#0d1a0f" : "#1a0e0e" }}>
              <div className="flex items-center justify-between text-[10px]">
                <span className="font-bold uppercase" style={{ color: l.result === "executed" ? "#4ade80" : "#f87171" }}>{l.result}</span>
                <span className="text-gray-500">{formatClock(l.time)}</span>
              </div>
              <div className="text-xs text-white mt-0.5">{l.pair}</div>
              <div className="flex items-center justify-between text-[10px] mt-0.5">
                <span className="text-blue-300">{l.venues.join(" → ")}</span>
                <span className="text-gray-400">{formatEdgePct(l.edge)}</span>
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5">{reasonCodeLabel(l.reasonCode)}: {l.reason}</div>
            </div>
          ))}
          {agentLogs.length === 0 && <p className="text-center text-gray-500 text-xs py-6">No activity yet.</p>}
        </div>
      )}
    </Drawer>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-300">
        {label}
        {hint && <span className="text-gray-600 ml-1">({hint})</span>}
      </span>
      {children}
    </div>
  );
}

function EdgeInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-gray-400">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={0.1}
          value={(value * 100).toFixed(1)}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="w-16 px-2 py-1 rounded text-right text-xs text-white outline-none border"
          style={{ background: "#0e1014", borderColor: "#2a2d35" }}
        />
        <span className="text-gray-500">%</span>
      </div>
    </div>
  );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t pt-3" style={{ borderColor: "#1e2130" }}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 w-full text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
