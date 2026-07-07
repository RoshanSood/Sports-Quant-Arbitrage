"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Trophy,
  RefreshCw,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
} from "lucide-react";
import {
  TrackedRecommendation,
  PerformanceBreakdown,
  RecordStats,
  League,
  MarketType,
} from "@/types/performance";

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayYYYYMMDD(): string {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, "0")}${String(n.getDate()).padStart(2, "0")}`;
}

function shiftDay(yyyymmdd: string, delta: number): string {
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLong(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00`);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const BOT_START_DATE = "20260707";

// ── Format helpers ────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function units(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}u`;
}

function roi(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

// ── Shared style maps ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  win:     "bg-green-900/30 text-green-400 border border-green-800/40",
  loss:    "bg-red-900/30 text-red-400 border border-red-800/40",
  push:    "bg-gray-800/30 text-gray-400 border border-gray-700/40",
  pending: "bg-yellow-900/20 text-yellow-400 border border-yellow-800/30",
  void:    "bg-gray-800/20 text-gray-600 border border-gray-700/20",
};

const RATING_COLORS: Record<string, string> = {
  safe:  "text-green-400",
  lean:  "text-blue-400",
  risky: "text-yellow-400",
  avoid: "text-red-400",
};

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-xl px-4 py-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">{label}</div>
      <div className={`text-xl font-bold ${color ?? "text-white"}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Record breakdown card ─────────────────────────────────────────────────────

function RecordCard({ label, stats, highlight }: {
  label: string; stats: RecordStats; highlight?: boolean;
}) {
  const roiVal = stats.roi;
  const roiColor = roiVal > 0 ? "text-green-400" : roiVal < 0 ? "text-red-400" : "text-gray-400";
  const hasData = stats.wins + stats.losses + stats.pushes > 0;
  return (
    <div className={`border rounded-xl px-3 py-2.5 ${highlight ? "bg-blue-900/10 border-blue-800/30" : "bg-[#1a1d24] border-[#2a2d35]"}`}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">{label}</div>
      {hasData ? (
        <>
          <div className="text-sm font-bold text-white">
            {stats.wins}W-{stats.losses}L{stats.pushes > 0 ? `-${stats.pushes}P` : ""}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-gray-400">{pct(stats.winRate)} WR</span>
            <span className={`text-xs font-semibold ${roiColor}`}>{roi(roiVal)} ROI</span>
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">{units(stats.unitsPL)} units</div>
        </>
      ) : (
        <p className="text-xs text-gray-600">No data yet</p>
      )}
      {stats.pending > 0 && (
        <div className="text-[10px] text-yellow-600 mt-1">{stats.pending} pending</div>
      )}
    </div>
  );
}

// ── Day play row ──────────────────────────────────────────────────────────────

function PlayRow({ rec }: { rec: TrackedRecommendation }) {
  const [expanded, setExpanded] = useState(false);
  const marketLabel = rec.marketType === "moneyline" ? "ML" : rec.marketType === "spread" ? "Spread" : "Total";
  const confColor = rec.confidence >= 8 ? "#22c55e" : rec.confidence >= 6 ? "#3b82f6" : "#eab308";

  return (
    <>
      <tr
        className="border-t border-[#22252d] hover:bg-[#1e2130]/50 cursor-pointer transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-3 py-2.5">
          <div className="text-xs font-semibold text-white">
            {rec.awayTeam.abbreviation} @ {rec.homeTeam.abbreviation}
          </div>
          <div className="text-[10px] text-gray-600">{rec.startTime}</div>
        </td>
        <td className="px-3 py-2.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{marketLabel}</span>
        </td>
        <td className="px-3 py-2.5 text-xs text-white font-semibold">{rec.recommendedPick}</td>
        <td className="px-3 py-2.5 text-[11px] text-gray-400 tabular-nums">{rec.displayPrice ?? "—"}</td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 rounded-full" style={{ width: `${rec.confidence * 5}px`, background: confColor }} />
            <span className="text-[11px] text-gray-400">{rec.confidence}/10</span>
          </div>
        </td>
        <td className="px-3 py-2.5">
          <span className={`text-[10px] font-bold capitalize ${RATING_COLORS[rec.rating] ?? "text-gray-400"}`}>{rec.rating}</span>
        </td>
        <td className="px-3 py-2.5">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[rec.status]}`}>{rec.status}</span>
        </td>
        <td className="px-3 py-2.5 text-[11px] text-gray-500 tabular-nums">
          {rec.finalScore ? `${rec.finalScore.away}–${rec.finalScore.home}` : "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-[#0e1016]">
          <td colSpan={8} className="px-4 py-3">
            <div className="text-xs text-gray-300 mb-1">
              <strong className="text-gray-400">Edge:</strong> {rec.reasoningSummary}
            </div>
            {rec.risks.length > 0 && (
              <div className="text-[11px] text-yellow-400/80">
                <strong className="text-gray-500">Risks:</strong> {rec.risks.join(" · ")}
              </div>
            )}
            {rec.gradingNotes && (
              <div className="text-[11px] text-gray-500 mt-1">{rec.gradingNotes}</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Day plays table ───────────────────────────────────────────────────────────

function DayPlaysTable({ recs }: { recs: TrackedRecommendation[] }) {
  if (recs.length === 0) {
    return (
      <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl flex flex-col items-center justify-center py-14 text-gray-500">
        <TrendingUp className="w-8 h-8 text-gray-700 mb-3" />
        <p className="text-sm font-medium">No value plays on this date</p>
        <p className="text-xs mt-1 text-gray-600">Value plays run daily at ~10 PM PT</p>
      </div>
    );
  }

  const wins   = recs.filter((r) => r.status === "win").length;
  const losses = recs.filter((r) => r.status === "loss").length;
  const pushes = recs.filter((r) => r.status === "push").length;
  const pending = recs.filter((r) => r.status === "pending").length;

  return (
    <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl overflow-hidden">
      {/* Day summary strip */}
      <div className="flex items-center gap-4 px-4 py-2.5 border-b border-[#2a2d35] bg-[#111318]">
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{recs.length} plays</span>
        {wins > 0   && <span className="text-[11px] text-green-400 font-semibold">{wins}W</span>}
        {losses > 0 && <span className="text-[11px] text-red-400 font-semibold">{losses}L</span>}
        {pushes > 0 && <span className="text-[11px] text-gray-400 font-semibold">{pushes}P</span>}
        {pending > 0 && <span className="text-[11px] text-yellow-500 font-semibold">{pending} pending</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[#2a2d35]">
              {["Game", "Market", "Pick", "Price", "Confidence", "Rating", "Result", "Score"].map((h) => (
                <th key={h} className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-gray-600">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recs.map((rec) => <PlayRow key={rec.id} rec={rec} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PerformanceClient() {
  const [breakdown, setBreakdown] = useState<PerformanceBreakdown | null>(null);
  const [allRecs, setAllRecs] = useState<TrackedRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [gradingResult, setGradingResult] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayYYYYMMDD());

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/performance?source=kalshi&limit=2000");
      if (!res.ok) throw new Error("Failed to load performance data");
      const data = await res.json();
      setBreakdown(data.breakdown);
      setAllRecs(data.recommendations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const gradeNow = async () => {
    setGrading(true);
    setGradingResult(null);
    try {
      const res = await fetch("/api/kalshi-grade-recommendations", { method: "POST" });
      const data = await res.json();
      setGradingResult(
        data.graded > 0
          ? `Graded ${data.graded} plays`
          : "No pending plays to grade"
      );
      await loadData();
    } catch {
      setGradingResult("Grading failed");
    } finally {
      setGrading(false);
    }
  };

  const prevDate = shiftDay(selectedDate, -1);
  const nextDate = shiftDay(selectedDate, 1);
  const canGoPrev = prevDate >= BOT_START_DATE;
  const canGoNext = nextDate <= todayYYYYMMDD();

  const dayRecs = allRecs.filter((r) => r.date === selectedDate);
  const overall = breakdown?.overall;

  const overallWinRate = overall && (overall.wins + overall.losses) > 0
    ? pct(overall.winRate)
    : "—";
  const overallROI = overall && (overall.wins + overall.losses) > 0
    ? roi(overall.roi)
    : "—";
  const overallUnitsPL = overall && (overall.wins + overall.losses) > 0
    ? units(overall.unitsPL)
    : "—";

  return (
    <div className="min-h-screen" style={{ background: "#111318" }}>
      <div className="max-w-5xl mx-auto px-4 pt-8 pb-16">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <Trophy className="w-7 h-7 text-yellow-500" />
              <h1 className="text-4xl font-bold text-white">Bot Performance</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400 border border-emerald-800/30 font-semibold">
                Kalshi
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              All value plays tracked · Starting July 7, 2026
            </p>
          </div>
          <button
            onClick={gradeNow}
            disabled={grading}
            className="flex items-center gap-2 px-4 py-2 bg-[#1a1d24] border border-[#2a2d35] hover:border-[#3a3d45] text-gray-300 text-sm rounded-xl transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${grading ? "animate-spin" : ""}`} />
            {grading ? "Grading..." : "Grade Pending"}
          </button>
        </div>

        {gradingResult && (
          <p className="text-xs text-blue-400 mb-4">{gradingResult}</p>
        )}

        {/* ── Loading ──────────────────────────────────────────────────────── */}
        {loading && (
          <div className="flex flex-col gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-[#1a1d24] border border-[#2a2d35] rounded-xl h-14 animate-pulse" />
            ))}
          </div>
        )}

        {/* ── Error ────────────────────────────────────────────────────────── */}
        {error && (
          <div className="flex items-center gap-2 bg-red-900/20 border border-red-800/40 rounded-xl px-4 py-3 text-red-400 text-sm mb-4">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {/* ── Content ──────────────────────────────────────────────────────── */}
        {!loading && !error && (
          <>
            {/* Overall summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <StatCard
                label="Record"
                value={overall ? `${overall.wins}W‑${overall.losses}L${overall.pushes > 0 ? `‑${overall.pushes}P` : ""}` : "0W‑0L"}
                sub={`${overall?.pending ?? 0} pending`}
              />
              <StatCard
                label="Win Rate"
                value={overallWinRate}
                sub="settled plays only"
                color={overall && overall.winRate >= 0.55 ? "text-green-400" : overall && overall.winRate > 0 ? "text-white" : undefined}
              />
              <StatCard
                label="Units P&L"
                value={overallUnitsPL}
                color={overall && overall.unitsPL > 0 ? "text-green-400" : overall && overall.unitsPL < 0 ? "text-red-400" : undefined}
              />
              <StatCard
                label="ROI"
                value={overallROI}
                sub={`${allRecs.length} total plays`}
                color={overall && overall.roi > 0 ? "text-green-400" : overall && overall.roi < 0 ? "text-red-400" : undefined}
              />
            </div>

            {/* Breakdown by market */}
            {breakdown && (
              <>
                <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">By Market</h2>
                <div className="grid grid-cols-3 gap-3 mb-5">
                  <RecordCard label="Moneyline" stats={breakdown.byMarket.moneyline} />
                  <RecordCard label="Spread"    stats={breakdown.byMarket.spread} />
                  <RecordCard label="Total"     stats={breakdown.byMarket.total} />
                </div>

                <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">By Confidence Tier</h2>
                <div className="grid grid-cols-3 gap-3 mb-5">
                  <RecordCard label="High (8–10)"   stats={breakdown.byConfidence.high}   highlight />
                  <RecordCard label="Medium (6–7)"  stats={breakdown.byConfidence.medium} />
                  <RecordCard label="Low (1–5)"     stats={breakdown.byConfidence.low} />
                </div>

                <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">By Claude Rating</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
                  <RecordCard label="Safe"  stats={breakdown.byRating.safe} />
                  <RecordCard label="Lean"  stats={breakdown.byRating.lean} />
                  <RecordCard label="Risky" stats={breakdown.byRating.risky} />
                  <RecordCard label="Avoid" stats={breakdown.byRating.avoid} />
                </div>
              </>
            )}

            {/* ── Daily plays navigator ──────────────────────────────────── */}
            <div className="flex items-center justify-between mb-4">
              <button
                onClick={() => canGoPrev && setSelectedDate(prevDate)}
                disabled={!canGoPrev}
                className="flex items-center gap-1 px-3 py-1.5 bg-[#1a1d24] border border-[#2a2d35] rounded-lg text-gray-400 text-xs disabled:opacity-30 hover:enabled:border-[#3a3d45] transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </button>

              <div className="text-center">
                <div className="text-base font-bold text-white">{formatDateLong(selectedDate)}</div>
                {selectedDate === todayYYYYMMDD() && (
                  <div className="text-[10px] text-blue-400 font-semibold uppercase tracking-widest">Today</div>
                )}
              </div>

              <button
                onClick={() => canGoNext && setSelectedDate(nextDate)}
                disabled={!canGoNext}
                className="flex items-center gap-1 px-3 py-1.5 bg-[#1a1d24] border border-[#2a2d35] rounded-lg text-gray-400 text-xs disabled:opacity-30 hover:enabled:border-[#3a3d45] transition-colors"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <DayPlaysTable recs={dayRecs} />
          </>
        )}
      </div>
    </div>
  );
}
