"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ArbLog, ArbResult } from "@/types/arbitrage";
import { FloatingPanel, Pill } from "./ui";
import { formatClock, formatEdgePct, formatMatchup, reasonCodeLabel } from "./arbFormat";

const RESULT_COLOR: Record<ArbResult, string> = {
  executed: "#22c55e",
  halted: "#ef4444",
  failed: "#ef4444",
  partial: "#eab308",
  naked: "#f97316",
};

type LogFilter = "all" | "executed" | "naked" | "halted";

const FILTERS: { value: LogFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "executed", label: "Executed" },
  { value: "naked", label: "Naked" },
  { value: "halted", label: "Halted" },
];

export default function ArbLogPanel({ logs, live = false, onClose }: { logs: ArbLog[]; live?: boolean; onClose: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<LogFilter>("all");

  const rows = filter === "all" ? logs : logs.filter((l) => l.result === filter);

  return (
    <FloatingPanel title="Arb Log" subtitle={`${rows.length} of ${logs.length} entries`} onClose={onClose} width="max-w-4xl">
      <div className="flex items-center gap-2 mb-3">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
          style={{
            background: live ? "#0d1a0f" : "#1a160e",
            color: live ? "#4ade80" : "#fbbf24",
            border: `1px solid ${live ? "#14532d" : "#3f2d10"}`,
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: live ? "#22c55e" : "#f59e0b" }} />
          {live ? "LIVE LOG" : "SCANNING…"}
        </span>
      </div>
      <div className="flex items-center gap-1 mb-3">
        {FILTERS.map(({ value, label }) => {
          const count = value === "all" ? logs.length : logs.filter((log) => log.result === value).length;
          return (
          <button
            key={value}
            onClick={() => {
              setFilter(value);
              setExpanded(null);
            }}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold capitalize ${
              filter === value ? "bg-amber-600 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {label} <span className="opacity-70">({count})</span>
          </button>
          );
        })}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b" style={{ borderColor: "#1e2130" }}>
            <th className="py-2 pr-3">Time</th>
            <th className="py-2 pr-3">Pair</th>
            <th className="py-2 pr-3">Venues</th>
            <th className="py-2 pr-3">Edge</th>
            <th className="py-2 pr-3">Mode</th>
            <th className="py-2 pr-3">Result</th>
            <th className="py-2 pr-3">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const open = expanded === l.id;
            return (
              <Fragment key={l.id}>
                <tr
                  className="border-b cursor-pointer hover:bg-[#15171e]"
                  style={{ borderColor: "#15171e" }}
                  onClick={() => setExpanded(open ? null : l.id)}
                >
                  <td className="py-2.5 pr-3 text-gray-400 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      {formatClock(l.time)}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-white">{formatMatchup(l.pair)}</td>
                  <td className="py-2.5 pr-3">
                    <span className="flex gap-1">
                      {l.venues.map((v) => (
                        <Pill key={v} color={v.includes("kalshi") ? "#3b82f6" : "#8b5cf6"} text={v.includes("kalshi") ? "#93c5fd" : "#c4b5fd"}>
                          {v[0].toUpperCase()}
                        </Pill>
                      ))}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-gray-300">{formatEdgePct(l.edge)}</td>
                  <td className="py-2.5 pr-3 uppercase text-blue-300">{l.mode}</td>
                  <td className="py-2.5 pr-3">
                    <Pill color={RESULT_COLOR[l.result]} text={RESULT_COLOR[l.result]}>{l.result}</Pill>
                  </td>
                  <td className="py-2.5 pr-3 text-gray-400">{reasonCodeLabel(l.reasonCode)}</td>
                </tr>
                {open && (
                  <tr style={{ background: "#0b0d12" }}>
                    <td colSpan={7} className="px-4 py-3">
                      <div className="text-[11px] text-gray-400 mb-1">{l.reason}</div>
                      <pre className="text-[10px] text-gray-500 overflow-x-auto rounded border p-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
                        {JSON.stringify(l.detailsJson, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </FloatingPanel>
  );
}
