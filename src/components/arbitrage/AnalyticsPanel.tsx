"use client";

import type { Trade } from "@/types/arbitrage";
import { FloatingPanel, StatCard } from "./ui";
import { formatEdgePct, formatSignedDollars } from "./arbFormat";

// Dark-surface chart palette (matches the module chrome). P&L uses reserved
// good/bad status colors; single-series charts use one recessive blue.
const C = {
  profit: "#34d399",
  loss: "#f87171",
  blue: "#3987e5",
  grid: "#232733",
  axis: "#383835",
  muted: "#898781",
  surface: "#0e1014",
  border: "#1e2130",
};

function marketTypeOf(t: Trade): "total" | "moneyline" | "spread" | "other" {
  const parts = t.legs[0]?.marketId.split(":") ?? [];
  const type = parts[2];
  if (type === "total" || type === "moneyline" || type === "spread") return type;
  return "other";
}

export default function AnalyticsPanel({ trades, onClose }: { trades: Trade[]; onClose: () => void }) {
  const paper = trades.filter((t) => t.mode === "paper");
  const settled = paper
    .filter((t) => t.realizedPnl != null)
    .sort((a, b) => (a.closedAt ?? a.openedAt).localeCompare(b.closedAt ?? b.openedAt));

  const totalPnl = settled.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const wins = settled.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const losses = settled.length - wins;
  const winRate = settled.length ? wins / settled.length : 0;
  const avgEdge = paper.length ? paper.reduce((s, t) => s + t.netEdge, 0) / paper.length : 0;

  // Cumulative realized P&L series (functional scan — no render-time mutation).
  const cum = settled.map((_, i) =>
    settled.slice(0, i + 1).reduce((s, t) => s + (t.realizedPnl ?? 0), 0)
  );

  // P&L by market type.
  const byType = (["total", "moneyline", "spread"] as const).map((type) => {
    const rows = settled.filter((t) => marketTypeOf(t) === type);
    return { type, pnl: rows.reduce((s, t) => s + (t.realizedPnl ?? 0), 0), count: rows.length };
  });

  // Net-edge distribution (all paper trades) into buckets.
  const edgeBuckets = buildEdgeHistogram(paper.map((t) => t.netEdge));

  return (
    <FloatingPanel title="Analytics" subtitle="Paper performance" onClose={onClose} width="max-w-4xl">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard label="Realized P&L" value={formatSignedDollars(totalPnl)} accent={totalPnl >= 0 ? C.profit : C.loss} />
        <StatCard label="Settled" value={String(settled.length)} sub={`${wins}W / ${losses}L`} />
        <StatCard label="Win Rate" value={formatEdgePct(winRate, 1)} />
        <StatCard label="Avg Net Edge" value={formatEdgePct(avgEdge, 2)} />
      </div>

      {settled.length === 0 ? (
        <p className="text-center text-gray-500 text-xs py-10">
          No settled paper positions yet — settle some trades to build performance history.
        </p>
      ) : (
        <>
          <ChartCard title="Cumulative realized P&L">
            <LineChart values={cum} />
          </ChartCard>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <ChartCard title="P&L by market type">
              <TypeBars data={byType} />
            </ChartCard>
            <ChartCard title="Net-edge distribution">
              <Histogram buckets={edgeBuckets} />
            </ChartCard>
          </div>
        </>
      )}
    </FloatingPanel>
  );
}

// ── chart primitives (inline SVG) ─────────────────────────────────────────────

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ borderColor: C.border, background: C.surface }}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">{title}</div>
      {children}
    </div>
  );
}

// Cumulative P&L line + area, zero baseline, last-value label. Single series → no legend.
function LineChart({ values }: { values: number[] }) {
  const W = 640;
  const H = 160;
  const pad = { l: 8, r: 44, t: 10, b: 10 };
  if (values.length === 0) return null;
  const series = values.length === 1 ? [0, values[0]] : values;
  const min = Math.min(0, ...series);
  const max = Math.max(0, ...series);
  const span = max - min || 1;
  const x = (i: number) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
  const zeroY = y(0);
  const line = series.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(series.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L ${x(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;
  const last = series[series.length - 1];
  const up = last >= 0;
  const color = up ? C.profit : C.loss;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 160 }}>
      <line x1={pad.l} y1={zeroY} x2={W - pad.r} y2={zeroY} stroke={C.axis} strokeWidth={1} />
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(series.length - 1)} cy={y(last)} r={3.5} fill={color} />
      <text x={W - pad.r + 4} y={y(last) + 3} fontSize={11} fill={color} fontWeight={600}>
        {formatSignedDollars(last)}
      </text>
    </svg>
  );
}

// P&L by market type — bars colored by sign (profit/loss status), labeled by type.
function TypeBars({ data }: { data: { type: string; pnl: number; count: number }[] }) {
  const W = 300;
  const H = 150;
  const pad = { l: 8, r: 8, t: 16, b: 22 };
  const max = Math.max(1, ...data.map((d) => Math.abs(d.pnl)));
  const zeroY = pad.t + (0.5) * (H - pad.t - pad.b) + 0; // centered baseline
  const plotH = (H - pad.t - pad.b) / 2;
  const bw = (W - pad.l - pad.r) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 150 }}>
      <line x1={pad.l} y1={zeroY} x2={W - pad.r} y2={zeroY} stroke={C.axis} strokeWidth={1} />
      {data.map((d, i) => {
        const cx = pad.l + bw * i + bw / 2;
        const h = (Math.abs(d.pnl) / max) * plotH;
        const up = d.pnl >= 0;
        const by = up ? zeroY - h : zeroY;
        const color = up ? C.profit : C.loss;
        return (
          <g key={d.type}>
            <rect x={cx - 16} y={by} width={32} height={Math.max(1, h)} rx={3} fill={color} opacity={0.9} />
            <text x={cx} y={up ? by - 4 : by + h + 11} fontSize={10} fill={color} textAnchor="middle" fontWeight={600}>
              {formatSignedDollars(d.pnl)}
            </text>
            <text x={cx} y={H - 6} fontSize={10} fill={C.muted} textAnchor="middle">
              {d.type === "moneyline" ? "ML" : d.type === "spread" ? "RL" : "O/U"} ({d.count})
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Net-edge histogram — single blue series (magnitude).
function Histogram({ buckets }: { buckets: { label: string; count: number }[] }) {
  const W = 300;
  const H = 150;
  const pad = { l: 8, r: 8, t: 10, b: 22 };
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bw = (W - pad.l - pad.r) / buckets.length;
  const baseY = H - pad.b;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 150 }}>
      <line x1={pad.l} y1={baseY} x2={W - pad.r} y2={baseY} stroke={C.axis} strokeWidth={1} />
      {buckets.map((b, i) => {
        const cx = pad.l + bw * i + bw / 2;
        const h = (b.count / max) * (baseY - pad.t);
        return (
          <g key={b.label}>
            <rect x={cx - bw / 2 + 3} y={baseY - h} width={bw - 6} height={Math.max(1, h)} rx={3} fill={C.blue} opacity={0.85} />
            {b.count > 0 && (
              <text x={cx} y={baseY - h - 3} fontSize={9} fill={C.muted} textAnchor="middle">
                {b.count}
              </text>
            )}
            <text x={cx} y={H - 6} fontSize={8} fill={C.muted} textAnchor="middle">
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function buildEdgeHistogram(edges: number[]): { label: string; count: number }[] {
  const bins = [
    { label: "<0%", lo: -Infinity, hi: 0 },
    { label: "0-2%", lo: 0, hi: 0.02 },
    { label: "2-5%", lo: 0.02, hi: 0.05 },
    { label: "5-10%", lo: 0.05, hi: 0.1 },
    { label: "10-25%", lo: 0.1, hi: 0.25 },
    { label: ">25%", lo: 0.25, hi: Infinity },
  ];
  return bins.map((b) => ({ label: b.label, count: edges.filter((e) => e >= b.lo && e < b.hi).length }));
}
