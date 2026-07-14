"use client";

import { useState } from "react";
import type { ArbLeg, Trade, TradeMode } from "@/types/arbitrage";
import { FloatingPanel, StatCard, Pill } from "./ui";
import { centsToDollars, formatClock, formatDollars, formatEdgePct, formatSignedDollars, timeAgo, tradeStatusColor } from "./arbFormat";

const STARTING_BANKROLL = 10000;

// ── Row helpers ──────────────────────────────────────────────────────────────

function venueName(id: string): string {
  const l = id.toLowerCase();
  if (l.includes("kalshi")) return "Kalshi";
  if (l.includes("poly")) return "Poly";
  if (l.includes("sx")) return "SX";
  if (l.includes("sport")) return "SM";
  return id;
}

function venueStyle(id: string): { color: string; text: string } {
  const l = id.toLowerCase();
  if (l.includes("kalshi")) return { color: "#3b82f6", text: "#93c5fd" };
  if (l.includes("poly")) return { color: "#8b5cf6", text: "#c4b5fd" };
  if (l.includes("sx")) return { color: "#a855f7", text: "#d8b4fe" };
  return { color: "#6b7280", text: "#d1d5db" };
}

// Dollars committed on a leg = contracts × price.
function legDollars(leg: ArbLeg): number {
  return centsToDollars(leg.size * leg.priceCents);
}

// Parse marketType + line out of a marketId like "kalshi:401..:total:6.5:over".
function parseMarket(marketId: string): { type: string; line: string | null } {
  const parts = marketId.split(":");
  return { type: parts[2] ?? "total", line: parts[3] ?? null };
}

function marketChipLabel(leg: ArbLeg | undefined): string {
  if (!leg) return "";
  const { type, line } = parseMarket(leg.marketId);
  if (type === "total") return line ? `O/U ${line}` : "O/U";
  if (type === "moneyline") return "ML";
  if (type === "spread") return line ? `Spread ${line}` : "Spread";
  return type;
}

function execDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US");
}

export default function PortfolioPanel({
  trades,
  live = false,
  onSettle,
  onClose,
}: {
  trades: Trade[];
  live?: boolean;
  onSettle?: (trade: Trade) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<TradeMode>("paper");
  const rows = trades.filter((t) => t.mode === mode);

  const open = rows.filter((t) => t.status === "open" || t.status === "partial" || t.status === "naked");
  const closed = rows.filter((t) => t.status === "settled" || t.status === "closed");
  const failed = rows.filter((t) => t.status === "failed" || t.status === "cancelled");
  const realized = rows.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const unrealized = open.reduce((s, t) => s + t.expectedProfit, 0);
  const exposure = open.reduce((s, t) => s + t.totalCost, 0);
  const settledWins = closed.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const winRate = closed.length ? settledWins / closed.length : 1;

  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed" | "failed">("all");
  const filterTabs: { key: typeof statusFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: rows.length },
    { key: "open", label: "Open", count: open.length },
    { key: "closed", label: "Closed", count: closed.length },
    { key: "failed", label: "Failed", count: failed.length },
  ];
  const visibleRows =
    statusFilter === "open" ? open : statusFilter === "closed" ? closed : statusFilter === "failed" ? failed : rows;

  return (
    <FloatingPanel title="Portfolio" onClose={onClose} width="max-w-5xl">
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
          {live ? "LIVE PAPER POSITIONS" : "MOCK DATA"}
        </span>
      </div>
      <div className="flex items-center gap-1 mb-4">
        {(["paper", "live"] as TradeMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 rounded text-xs font-semibold capitalize ${
              mode === m ? "bg-blue-600 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {m === "live" ? "⚠ Real" : "Paper"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <StatCard label="Bet / Event" value="$50" sub="Max per arb" />
        <StatCard label="Balance" value={formatDollars(STARTING_BANKROLL + realized)} sub={`Started: $${STARTING_BANKROLL.toLocaleString()}`} />
        <StatCard label="Total P&L" value={formatSignedDollars(realized)} accent={realized >= 0 ? "#34d399" : "#f87171"} />
        <StatCard label="Unrealized P&L" value={formatSignedDollars(unrealized)} accent="#34d399" />
        <StatCard label="Open / Total" value={`${open.length} / ${rows.length}`} sub={`Exposure: ${formatDollars(exposure)}`} />
        <StatCard label="Win Rate" value={formatEdgePct(winRate, 1)} sub={`${settledWins}W / ${closed.length - settledWins}L`} />
      </div>

      <div className="rounded-lg border px-4 py-3 mb-4 text-[11px] text-gray-400" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
        Paper trades follow the full execution pipeline (REST verification, depth check, balance check). They
        auto-settle when the event resolves on the venue. Post-fill verification checks whether the arb would
        still exist after execution delay.
      </div>

      <div className="flex items-center gap-4 mb-3 border-b" style={{ borderColor: "#1e2130" }}>
        {filterTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatusFilter(t.key)}
            className={`pb-2 text-xs font-semibold transition-colors ${
              statusFilter === t.key ? "text-white border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b" style={{ borderColor: "#1e2130" }}>
              <th className="py-2 pr-3">Event</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3 text-right">Leg A</th>
              <th className="py-2 pr-3 text-right">Leg B</th>
              <th className="py-2 pr-3">Total</th>
              <th className="py-2 pr-3">Edge</th>
              <th className="py-2 pr-3">CLV</th>
              <th className="py-2 pr-3">P&L</th>
              <th className="py-2 pr-3">Executed</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((t) => {
              const venues = [...new Set(t.legs.map((l) => l.venueId))];
              const a = t.legs[0];
              const b = t.legs[1];
              const arbDesc = a && b ? `${a.venueId}_${a.outcome}_vs_${b.venueId}_${b.outcome}` : "";
              const contracts = a?.size ?? 0;
              return (
                <tr key={t.id} className="border-b align-top" style={{ borderColor: "#15171e" }}>
                  {/* EVENT */}
                  <td className="py-3 pr-3">
                    <div className="font-semibold text-white">{t.matchup}</div>
                    <div className="flex gap-1 mt-1">
                      {venues.map((v) => {
                        const s = venueStyle(v);
                        return <Pill key={v} color={s.color} text={s.text}>{venueName(v)}</Pill>;
                      })}
                    </div>
                    <div className="flex items-center gap-1 mt-1 text-[10px] text-gray-600">
                      <span className="truncate max-w-[190px]">{arbDesc}</span>
                      <span className="text-gray-500">Arb</span>
                      <Pill>{marketChipLabel(a)}</Pill>
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <Pill color="#8b5cf6" text="#c4b5fd">{t.agentId}</Pill>
                      <Pill color={t.mode === "live" ? "#ef4444" : "#22c55e"} text={t.mode === "live" ? "#fca5a5" : "#86efac"}>
                        {t.mode === "live" ? "REAL" : "PAPER"}
                      </Pill>
                      <span className="text-[10px] text-gray-500">{contracts} contracts</span>
                    </div>
                  </td>
                  {/* STATUS */}
                  <td className="py-3 pr-3">
                    <Pill color={tradeStatusColor(t.status)} text={tradeStatusColor(t.status)}>{t.status}</Pill>
                  </td>
                  {/* LEG A / LEG B */}
                  <LegColumn leg={a} />
                  <LegColumn leg={b} />
                  {/* TOTAL */}
                  <td className="py-3 pr-3 text-gray-200 font-semibold">{formatDollars(t.totalCost)}</td>
                  {/* EDGE + net $ */}
                  <td className="py-3 pr-3">
                    <div>
                      <span className="text-[10px] text-gray-500 mr-1">NET</span>
                      <span className="text-emerald-400 font-semibold">{formatEdgePct(t.netEdge)}</span>
                    </div>
                    <div className="text-[10px] text-gray-500">{formatDollars(t.expectedProfit)}</div>
                  </td>
                  {/* CLV */}
                  <td className="py-3 pr-3 text-gray-400">
                    {t.clvDrift != null ? (
                      <span style={{ color: t.clvDrift >= 0 ? "#34d399" : "#f87171" }}>
                        Drift {t.clvDrift >= 0 ? "+" : ""}{formatEdgePct(t.clvDrift)}
                      </span>
                    ) : (
                      <span className="text-gray-600">N/A</span>
                    )}
                  </td>
                  {/* P&L */}
                  <td className="py-3 pr-3" style={{ color: (t.realizedPnl ?? 0) >= 0 ? "#34d399" : "#f87171" }}>
                    {t.realizedPnl != null ? formatSignedDollars(t.realizedPnl) : "—"}
                  </td>
                  {/* EXECUTED — when the position was opened (trade execution time) */}
                  <td className="py-3 pr-3 text-gray-500 whitespace-nowrap">
                    <div className="text-gray-300">{execDate(t.openedAt)}</div>
                    <div className="text-[10px] text-gray-400">{formatClock(t.openedAt)}</div>
                    <div className="text-[10px] text-gray-600">{timeAgo(t.openedAt)}</div>
                  </td>
                  {/* ACTIONS */}
                  <td className="py-3 pr-3">
                    {onSettle && (t.status === "open" || t.status === "partial" || t.status === "naked") && (
                      <button
                        onClick={() => onSettle(t)}
                        className="px-2 py-1 rounded text-[10px] font-semibold text-white"
                        style={{ background: "#059669" }}
                      >
                        Settle
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr><td colSpan={10} className="py-8 text-center text-gray-500">
                No {statusFilter === "all" ? mode : statusFilter} positions.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </FloatingPanel>
  );
}

// A position leg: venue on top, then decimal odds (cents) side, then $ committed —
// mirroring the reference portfolio layout.
function LegColumn({ leg }: { leg?: ArbLeg }) {
  if (!leg) return <td className="py-3 pr-3 text-right text-gray-600">—</td>;
  const s = venueStyle(leg.venueId);
  const side = leg.label ?? leg.outcome;
  return (
    <td className="py-3 pr-3 text-right align-top whitespace-nowrap">
      <div className="text-[10px]" style={{ color: s.text }}>{venueName(leg.venueId)}</div>
      <div className="font-semibold text-white">
        {leg.decimalOdds.toFixed(2)} <span className="text-gray-400">({leg.priceCents}c)</span>{" "}
        <span className="text-gray-300 capitalize">{side}</span>
      </div>
      <div className="text-[10px] text-gray-500">{formatDollars(legDollars(leg))}</div>
    </td>
  );
}
