"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import type { ArbLeg, Trade, TradeMode } from "@/types/arbitrage";
import { FloatingPanel, StatCard, Pill } from "./ui";
import { centsToDollars, formatClock, formatDollars, formatEdgePct, formatSignedDollars, timeAgo, tradeStatusColor, venueDisplayName, venueStyle } from "./arbFormat";

const STARTING_BANKROLL = 10000;

// ── Row helpers ──────────────────────────────────────────────────────────────

// Dollars committed on a leg = contracts × price.
function legDollars(leg: ArbLeg): number {
  return centsToDollars(leg.size * leg.priceCents);
}

// Executed prices carry sub-cent precision (e.g. a FOK filled at 79.8c). Show up to one
// decimal, trimming a trailing ".0" so whole-cent fills still read "79c".
function fmtCents(cents: number): string {
  return Number(cents.toFixed(1)).toString();
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

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tradeMarketType(t: Trade): string {
  return parseMarket(t.legs[0]?.marketId ?? "").type;
}

function tradeLine(t: Trade): string | null {
  return parseMarket(t.legs[0]?.marketId ?? "").line;
}

function downloadTradesCsv(filename: string, rows: Trade[]) {
  const headers = [
    "id",
    "date",
    "mode",
    "status",
    "fillStatus",
    "matchup",
    "marketType",
    "line",
    "agentId",
    "opportunityId",
    "openedAt",
    "closedAt",
    "totalCost",
    "expectedProfit",
    "realizedPnl",
    "netEdge",
    "clvDrift",
    "venues",
    "legsJson",
    "orderIdsJson",
    "finalScoreJson",
    "postFillJson",
    "executionStepsJson",
    "nakedLegIndex",
  ];
  const body = rows.map((t) => [
    t.id,
    t.date,
    t.mode,
    t.status,
    t.fillStatus,
    t.matchup,
    tradeMarketType(t),
    tradeLine(t),
    t.agentId,
    t.opportunityId,
    t.openedAt,
    t.closedAt,
    t.totalCost,
    t.expectedProfit,
    t.realizedPnl,
    t.netEdge,
    t.clvDrift,
    [...new Set(t.legs.map((l) => l.venueId))].join("|"),
    t.legs,
    t.orderIds,
    t.finalScore ?? null,
    t.postFill ?? null,
    t.executionSteps ?? [],
    t.nakedLegIndex ?? null,
  ]);
  const csv = [headers, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  const [mode, setMode] = useState<TradeMode>("live");
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
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
  const exportName = `arbitrage-${mode}-trades-${new Date().toISOString().slice(0, 10)}.csv`;

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
          {live ? "LIVE PAPER POSITIONS" : "SCANNING…"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1">
        {(["live", "paper"] as TradeMode[]).map((m) => (
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
        <button
          onClick={() => downloadTradesCsv(exportName, rows)}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold text-gray-200 border disabled:opacity-40 disabled:cursor-not-allowed hover:text-white"
          style={{ borderColor: "#2a2f3e", background: "#11141a" }}
        >
          <Download className="w-3.5 h-3.5" />
          Download CSV
        </button>
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
              const expanded = expandedTradeId === t.id;
              const venues = [...new Set(t.legs.map((l) => l.venueId))];
              const a = t.legs[0];
              const b = t.legs[1];
              const arbDesc = a && b ? `${a.venueId}_${a.outcome}_vs_${b.venueId}_${b.outcome}` : "";
              const contracts = a?.size ?? 0;
              return (
                <Fragment key={t.id}>
                <tr className="border-b align-top" style={{ borderColor: "#15171e" }}>
                  {/* EVENT */}
                  <td className="py-3 pr-3">
                    <button
                      onClick={() => setExpandedTradeId(expanded ? null : t.id)}
                      className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold text-gray-500 hover:text-gray-300"
                    >
                      {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      Details
                    </button>
                    <div className="font-semibold text-white">{t.matchup}</div>
                    <div className="flex gap-1 mt-1">
                      {venues.map((v) => {
                        const s = venueStyle(v);
                        return <Pill key={v} color={s.color} text={s.text}>{venueDisplayName(v)}</Pill>;
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
                    <div className="flex flex-col items-start gap-2">
                    {onSettle && (t.status === "open" || t.status === "partial" || t.status === "naked") && (
                      <button
                        onClick={() => onSettle(t)}
                        className="px-2 py-1 rounded text-[10px] font-semibold text-white"
                        style={{ background: "#059669" }}
                      >
                        Settle
                      </button>
                    )}
                    <a
                      href={`/api/arbitrage/trades/${encodeURIComponent(t.id)}/postmortem?date=${t.date}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] font-semibold text-blue-300 hover:text-blue-200"
                    >
                      API
                    </a>
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b" style={{ borderColor: "#15171e", background: "#0b0d12" }}>
                    <td colSpan={10} className="px-4 py-3">
                      <TradeDetails trade={t} />
                    </td>
                  </tr>
                )}
                </Fragment>
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

function TradeDetails({ trade }: { trade: Trade }) {
  const postFill = trade.postFill;
  const postColor =
    postFill?.status === "arb_gone" ? "#22c55e" : postFill?.status === "edge_intact" ? "#eab308" : "#6b7280";
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_1.2fr_1fr] text-[11px]">
      <div className="rounded-lg border p-3" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
        <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Post-fill</div>
        <div className="flex items-center gap-2">
          <Pill color={postColor} text={postColor}>{postFill?.status?.replace("_", " ") ?? "not checked"}</Pill>
          {postFill?.remainingNetEdge != null && <span className="text-gray-300">{formatEdgePct(postFill.remainingNetEdge)}</span>}
        </div>
        <div className="mt-2 text-gray-400">{postFill?.reason ?? "No post-fill verification stored for this trade."}</div>
        {postFill?.edgeDrift != null && (
          <div className="mt-1 text-gray-500">Drift {postFill.edgeDrift >= 0 ? "+" : ""}{formatEdgePct(postFill.edgeDrift)}</div>
        )}
      </div>

      <div className="rounded-lg border p-3" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
        <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Pipeline</div>
        <div className="grid gap-1.5">
          {(trade.executionSteps ?? []).map((step) => (
            <div key={`${trade.id}-${step.key}`} className="flex items-start gap-2">
              <span
                className="mt-1 h-1.5 w-1.5 rounded-full shrink-0"
                style={{ background: step.status === "pass" ? "#22c55e" : step.status === "warn" ? "#eab308" : step.status === "halt" ? "#ef4444" : "#6b7280" }}
              />
              <div className="min-w-0">
                <span className="font-semibold text-gray-200">{step.label}</span>
                {step.detail && <span className="text-gray-500"> - {step.detail}</span>}
              </div>
            </div>
          ))}
          {(trade.executionSteps ?? []).length === 0 && <div className="text-gray-500">No gate trail stored.</div>}
        </div>
      </div>

      <div className="rounded-lg border p-3" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
        <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Storage</div>
        <div className="space-y-1 text-gray-400">
          <div><span className="text-gray-500">Trade:</span> {trade.id}</div>
          <div><span className="text-gray-500">Opportunity:</span> {trade.opportunityId}</div>
          <div><span className="text-gray-500">File:</span> data/arbitrage/trades/{trade.date}.json</div>
        </div>
        <div className="mt-3 text-[10px] uppercase tracking-wide text-gray-500">Orders</div>
        <div className="mt-1 space-y-1">
          {trade.orderIds.map((id, i) => (
            <div key={`${trade.id}-order-${i}`} className="truncate text-gray-400">
              <span className="text-gray-500">{trade.legs[i]?.venueId ?? `leg ${i + 1}`}:</span> {id ?? "none"}
            </div>
          ))}
        </div>
      </div>
    </div>
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
      <div className="text-[10px]" style={{ color: s.text }}>{venueDisplayName(leg.venueId)}</div>
      <div className="font-semibold text-white">
        {leg.decimalOdds.toFixed(2)} <span className="text-gray-400">({fmtCents(leg.priceCents)}c)</span>{" "}
        <span className="text-gray-300 capitalize">{side}</span>
      </div>
      <div className="text-[10px] text-gray-500">{formatDollars(legDollars(leg))}</div>
    </td>
  );
}
