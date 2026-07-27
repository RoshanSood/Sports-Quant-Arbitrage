"use client";

import { Play, RefreshCw } from "lucide-react";
import type { ArbLog, ArbOpportunity, MainLineWatch, Trade } from "@/types/arbitrage";
import { FloatingPanel, Pill } from "./ui";
import { formatCents, formatClock, formatDollars, formatEdgePct, formatOdds, timeAgo } from "./arbFormat";

export default function ArbsPanel({
  opportunities,
  trades = [],
  logs = [],
  watch = [],
  executingIds = new Set<string>(),
  agentName,
  live = false,
  refreshing = false,
  onRefresh,
  onClose,
  onPlay,
}: {
  opportunities: ArbOpportunity[];
  trades?: Trade[];
  logs?: ArbLog[];
  watch?: MainLineWatch[];
  executingIds?: Set<string>;
  agentName: string;
  live?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onClose: () => void;
  onPlay: (opp: ArbOpportunity) => void;
}) {
  // Most-recent execution time per opportunity, so a played arb shows when the
  // trade was executed (vs. just when the opportunity was detected).
  const execByOpp = new Map<string, string>();
  for (const t of trades) {
    const prev = execByOpp.get(t.opportunityId);
    if (!prev || new Date(t.openedAt) > new Date(prev)) execByOpp.set(t.opportunityId, t.openedAt);
  }
  const logsByOpp = new Map<string, ArbLog>();
  for (const log of logs) {
    const id = typeof log.detailsJson?.opportunityId === "string" ? log.detailsJson.opportunityId : null;
    if (!id) continue;
    const prev = logsByOpp.get(id);
    if (!prev || log.time > prev.time) logsByOpp.set(id, log);
  }
  const tradesByOpp = new Map<string, Trade>();
  for (const trade of trades) {
    const prev = tradesByOpp.get(trade.opportunityId);
    if (!prev || trade.openedAt > prev.openedAt) tradesByOpp.set(trade.opportunityId, trade);
  }
  return (
    <FloatingPanel title="Arbs" subtitle={`Arbs: ${opportunities.length}`} onClose={onClose} width="max-w-5xl">
      <div className="mb-3 flex items-center gap-2 text-[11px]">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold"
          style={{
            background: live ? "#0d1a0f" : "#1a160e",
            color: live ? "#4ade80" : "#fbbf24",
            border: `1px solid ${live ? "#14532d" : "#3f2d10"}`,
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: live ? "#22c55e" : "#f59e0b" }} />
          {live ? "LIVE DETECTION" : "SCANNING…"}
        </span>
        <span className="text-gray-500 uppercase tracking-wide ml-2">Agents</span>
        <Pill color="#8b5cf6" text="#c4b5fd">{agentName}</Pill>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-gray-300 border disabled:opacity-50"
            style={{ borderColor: "#2a2d35", background: "#12151d" }}
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Scanning…" : "Refresh"}
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b" style={{ borderColor: "#1e2130" }}>
              <th className="py-2 pr-3">Match</th>
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Leg A</th>
              <th className="py-2 pr-3">Leg B</th>
              <th className="py-2 pr-3">Cost</th>
              <th className="py-2 pr-3">Gross</th>
              <th className="py-2 pr-3">Net</th>
              <th className="py-2 pr-3">Sizes</th>
              <th className="py-2 pr-3">Executed</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Open</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((opp) => {
              const [a, b] = opp.legs;
              const execAt = execByOpp.get(opp.id);
              const rowStatus = arbRowStatus(opp, logsByOpp.get(opp.id), tradesByOpp.get(opp.id), executingIds.has(opp.id));
              return (
                <tr key={opp.id} className="border-b align-top" style={{ borderColor: "#15171e" }}>
                  <td className="py-3 pr-3">
                    <div className="font-semibold text-white">{opp.matchup}</div>
                    <div className="text-[10px] text-gray-500">Agent: {opp.agentId}</div>
                    {opp.line != null && <div className="text-[10px] text-gray-500">O/U {opp.line}</div>}
                  </td>
                  <td className="py-3 pr-3">
                    <Pill>
                      {opp.marketType === "moneyline"
                        ? "ML"
                        : opp.marketType === "spread"
                        ? `RL ${opp.line}`
                        : `total_${opp.line}`}
                    </Pill>
                  </td>
                  <LegCell leg={a} />
                  <LegCell leg={b} />
                  <td className="py-3 pr-3 text-gray-300">{formatCents(opp.totalCostCents)}</td>
                  <td className="py-3 pr-3 text-emerald-400 font-semibold">+{formatEdgePct(opp.grossEdge)}</td>
                  <td className="py-3 pr-3">
                    <span className="inline-flex items-center gap-1">
                      <Pill color="#f97316" text="#fdba74">Tracked</Pill>
                      <span className="text-emerald-400 font-semibold">+{formatEdgePct(opp.netEdge)}</span>
                    </span>
                  </td>
                  <td className="py-3 pr-3 text-gray-400 whitespace-nowrap">
                    {formatDollars(opp.stakePlan.legSizes[a.venueId] ?? 0)} / {formatDollars(opp.stakePlan.legSizes[b.venueId] ?? 0)}
                  </td>
                  {/* EXECUTED — trade execution time once played, else detection time */}
                  <td className="py-3 pr-3 whitespace-nowrap">
                    {execAt ? (
                      <>
                        <div className="text-[11px] font-semibold text-emerald-300">{formatClock(execAt)}</div>
                        <div className="text-[10px] text-gray-600">{timeAgo(execAt)}</div>
                      </>
                    ) : (
                      <div className="text-[10px] text-gray-600">Detected {timeAgo(opp.detectedAt)}</div>
                    )}
                  </td>
                  <td className="py-3 pr-3">
                    <StatusPill status={rowStatus} />
                    {rowStatus.reason && <div className="mt-1 max-w-40 truncate text-[10px] text-gray-600" title={rowStatus.reason}>{rowStatus.reason}</div>}
                  </td>
                  <td className="py-3 pr-3">
                    <button
                      onClick={() => onPlay(opp)}
                      disabled={rowStatus.kind === "executing"}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white"
                      style={{ background: rowStatus.kind === "executing" ? "#4b5563" : "#d946ef" }}
                    >
                      <Play className="w-3 h-3" /> {rowStatus.kind === "executing" ? "Running" : "Play"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {opportunities.length === 0 && (
              <tr>
                <td colSpan={11} className="py-8 text-center text-gray-500">
                  {live
                    ? "No guaranteed arbs on the current slate above the agent's min edge after fees."
                    : "No opportunities detected yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <WatchBoard watch={watch} />
    </FloatingPanel>
  );
}

// Live monitoring of each game's MAIN total line — even when there's no tradeable
// arb. Lets you watch the engine lock onto ~7.5-9.5 and spot an edge the moment
// the two venues diverge on the main line.
type RowStatus = {
  kind: "detected" | "executing" | "successful" | "failed" | "unhedged" | "partial" | "open";
  label: string;
  reason?: string;
};

function arbRowStatus(opp: ArbOpportunity, log: ArbLog | undefined, trade: Trade | undefined, executing: boolean): RowStatus {
  if (executing) return { kind: "executing", label: "Executing" };
  if (log) {
    if (log.result === "executed") return { kind: "successful", label: "Successful", reason: log.reason };
    if (log.result === "naked") return { kind: "unhedged", label: "Unhedged", reason: log.reason };
    if (log.result === "partial") return { kind: "partial", label: "Partial", reason: log.reason };
    return { kind: "failed", label: "Failed", reason: log.reason };
  }
  if (trade) {
    if (trade.status === "open") return { kind: "open", label: "Open" };
    if (trade.status === "naked") return { kind: "unhedged", label: "Unhedged" };
    if (trade.status === "partial") return { kind: "partial", label: "Partial" };
    if (trade.status === "failed") return { kind: "failed", label: "Failed" };
    if (trade.status === "settled") return { kind: "successful", label: "Settled" };
  }
  return { kind: "detected", label: `Detected ${timeAgo(opp.detectedAt)}` };
}

function StatusPill({ status }: { status: RowStatus }) {
  const colors = {
    detected: { color: "#3b4252", text: "#cbd5e1" },
    executing: { color: "#075985", text: "#7dd3fc" },
    successful: { color: "#14532d", text: "#86efac" },
    failed: { color: "#7c2d12", text: "#fdba74" },
    unhedged: { color: "#7f1d1d", text: "#fca5a5" },
    partial: { color: "#713f12", text: "#fde68a" },
    open: { color: "#064e3b", text: "#6ee7b7" },
  } as const;
  const c = colors[status.kind];
  return <Pill color={c.color} text={c.text}>{status.label}</Pill>;
}

function WatchBoard({ watch }: { watch: MainLineWatch[] }) {
  if (watch.length === 0) return null;
  const statusStyle = {
    arb: { color: "#22c55e", label: "ARB" },
    stale: { color: "#ef4444", label: "STALE" },
    no_edge: { color: "#6b7280", label: "no edge" },
  } as const;

  return (
    <div className="mt-6">
      <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">
        Main-line watch ({watch.length}) · each game&apos;s primary total
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b" style={{ borderColor: "#1e2130" }}>
            <th className="py-2 pr-3">Match</th>
            <th className="py-2 pr-3">Total</th>
            <th className="py-2 pr-3">Kalshi (O / U)</th>
            <th className="py-2 pr-3">Poly (O / U)</th>
            <th className="py-2 pr-3">Best cost</th>
            <th className="py-2 pr-3">Net edge</th>
            <th className="py-2 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {watch.map((w) => {
            const k = w.venuePrices.find((v) => v.venueId === "kalshi");
            const p = w.venuePrices.find((v) => v.venueId === "polymarket");
            const s = statusStyle[w.status];
            return (
              <tr key={w.eventKey} className="border-b" style={{ borderColor: "#15171e" }}>
                <td className="py-2 pr-3 text-white">{w.matchup}</td>
                <td className="py-2 pr-3"><Pill>O/U {w.line}</Pill></td>
                <td className="py-2 pr-3 text-blue-300">{cents(k?.overCents)} / {cents(k?.underCents)}</td>
                <td className="py-2 pr-3 text-purple-300">{cents(p?.overCents)} / {cents(p?.underCents)}</td>
                <td className="py-2 pr-3 text-gray-300">{formatCents(w.totalCostCents)}</td>
                <td className="py-2 pr-3 font-semibold" style={{ color: w.netEdge >= 0 ? "#34d399" : "#9ca3af" }}>
                  {(w.netEdge >= 0 ? "+" : "") + formatEdgePct(w.netEdge)}
                </td>
                <td className="py-2 pr-3">
                  <Pill color={s.color} text={s.color}>{s.label}</Pill>
                  {w.status === "stale" && <span className="ml-1 text-[10px] text-gray-600">{w.divergenceCents}c gap</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-600 mt-2">
        Venues agree on the main line ⇒ no arb (efficient). An arb appears when they diverge without tripping the stale gate.
      </p>
    </div>
  );
}

function cents(c: number | null | undefined): string {
  return c == null ? "—" : `${c}¢`;
}

function LegCell({ leg }: { leg: ArbOpportunity["legs"][number] }) {
  const venueColor = leg.venueId.includes("kalshi")
    ? "#60a5fa"
    : leg.venueId.includes("sx")
    ? "#d8b4fe"
    : "#c4b5fd";
  const liq = leg.liquidityUsd;
  return (
    <td className="py-3 pr-3">
      <div className="font-semibold capitalize" style={{ color: venueColor }}>
        {leg.venueId}
      </div>
      <div className="text-gray-300">{leg.label}</div>
      <div className="text-[10px] text-gray-500">
        {formatOdds(leg.decimalOdds)} ({formatCents(leg.priceCents)})
      </div>
      {liq != null && liq < 1e8 && (
        <div className="text-[10px] text-gray-600">~${Math.round(liq)} avail</div>
      )}
    </td>
  );
}
