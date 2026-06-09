"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Trophy,
  RefreshCw,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Check,
  X,
  DollarSign,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import {
  TrackedRecommendation,
  PerformanceBreakdown,
  RecordStats,
  League,
  MarketType,
  BankrollData,
  BankrollBet,
} from "@/types/performance";
import { useDataSource } from "./DataSourceContext";

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

const FIRST_DATE_POLY = "20260523";
const FIRST_DATE_KALSHI = "20260527";

// ── Format helpers ────────────────────────────────────────────────────────────

function dollar(n: number, showSign = false): string {
  const sign = showSign ? (n >= 0 ? "+" : "") : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

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
  safe:   "text-green-400",
  lean:   "text-blue-400",
  risky:  "text-yellow-400",
  avoid:  "text-red-400",
};

// ── Generic stat card ─────────────────────────────────────────────────────────

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

// ── Stats breakdown card ──────────────────────────────────────────────────────

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
        <p className="text-xs text-gray-600">No data</p>
      )}
      {stats.pending > 0 && (
        <div className="text-[10px] text-yellow-600 mt-1">{stats.pending} pending</div>
      )}
    </div>
  );
}

// ── Stats tab recommendation row ──────────────────────────────────────────────

function RecommendationRow({ rec }: { rec: TrackedRecommendation }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr
        className="border-t border-[#22252d] hover:bg-[#1e2130]/50 cursor-pointer transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-3 py-2 text-[11px] text-gray-500 whitespace-nowrap">
          {rec.date.slice(4, 6)}/{rec.date.slice(6, 8)}
        </td>
        <td className="px-3 py-2">
          <div className="text-xs font-semibold text-white">
            {rec.awayTeam.abbreviation} @ {rec.homeTeam.abbreviation}
          </div>
          <div className="text-[10px] text-gray-600">{rec.startTime}</div>
        </td>
        <td className="px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{rec.marketType}</span>
        </td>
        <td className="px-3 py-2 text-xs text-white font-medium">{rec.recommendedPick}</td>
        <td className="px-3 py-2 text-[11px] text-gray-400 tabular-nums">{rec.displayPrice ?? "N/A"}</td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            <div
              className="h-1.5 rounded-full"
              style={{
                width: `${rec.confidence * 6}px`,
                background: rec.confidence >= 8 ? "#22c55e" : rec.confidence >= 6 ? "#3b82f6" : "#eab308",
              }}
            />
            <span className="text-[11px] text-gray-400">{rec.confidence}/10</span>
          </div>
        </td>
        <td className="px-3 py-2">
          <span className={`text-[10px] font-bold capitalize ${RATING_COLORS[rec.rating]}`}>{rec.rating}</span>
        </td>
        <td className="px-3 py-2">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[rec.status]}`}>{rec.status}</span>
        </td>
        <td className="px-3 py-2 text-[11px] text-gray-500">
          {rec.finalScore ? `${rec.finalScore.away}-${rec.finalScore.home}` : "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-[#0e1016]">
          <td colSpan={9} className="px-4 py-3">
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
            <div className="text-[10px] text-gray-700 mt-1">
              Source: {rec.source.replace(/_/g, " ")} · Generated: {new Date(rec.generatedAt).toLocaleString()}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Bankroll bet row ──────────────────────────────────────────────────────────

function BetRow({ bet }: { bet: BankrollBet }) {
  const profitColor =
    bet.profit == null ? "text-gray-500"
    : bet.profit > 0 ? "text-green-400"
    : bet.profit < 0 ? "text-red-400"
    : "text-gray-400";

  const profitDisplay =
    bet.status === "pending" ? "—"
    : bet.status === "void" ? "void"
    : bet.profit != null ? dollar(bet.profit, true)
    : "—";

  return (
    <tr className="border-t border-[#22252d] hover:bg-[#1e2130]/30 transition-colors">
      <td className="px-3 py-2.5">
        <div className="text-xs font-semibold text-white">{bet.game}</div>
      </td>
      <td className="px-3 py-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{bet.marketType}</span>
      </td>
      <td className="px-3 py-2.5 text-xs text-white font-medium">{bet.pick}</td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1">
          <div
            className="h-1.5 rounded-full"
            style={{
              width: `${bet.confidence * 5}px`,
              background: bet.confidence >= 8 ? "#22c55e" : bet.confidence >= 6 ? "#3b82f6" : "#eab308",
            }}
          />
          <span className="text-[11px] text-gray-400">{bet.confidence}/10</span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-[11px] text-gray-300 tabular-nums">{bet.units}u</td>
      <td className="px-3 py-2.5 text-[11px] text-white font-semibold tabular-nums">
        {dollar(bet.betAmount)}
      </td>
      <td className="px-3 py-2.5 text-[11px] text-gray-400 tabular-nums">
        {bet.displayPrice ?? "—"}
      </td>
      <td className="px-3 py-2.5">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[bet.status]}`}>
          {bet.status}
        </span>
      </td>
      <td className={`px-3 py-2.5 text-xs font-bold tabular-nums ${profitColor}`}>
        {profitDisplay}
      </td>
    </tr>
  );
}

// ── Bankroll tab ──────────────────────────────────────────────────────────────

function BankrollTab({
  onGrade,
  grading,
  source,
}: {
  onGrade: () => void;
  grading: boolean;
  source: "polymarket" | "kalshi";
}) {
  const endpoint = source === "kalshi" ? "/api/kalshi-bankroll" : "/api/bankroll";
  const firstDate = source === "kalshi" ? FIRST_DATE_KALSHI : FIRST_DATE_POLY;
  const sourceLabel = source === "kalshi" ? "Kalshi" : "Polymarket";
  const sourceAccent = source === "kalshi" ? "text-emerald-400" : "text-blue-400";

  const [bankroll, setBankroll] = useState<BankrollData | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayYYYYMMDD());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingUnit, setEditingUnit] = useState(false);
  const [unitInput, setUnitInput] = useState("");

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${endpoint}?date=${date}`);
      if (!res.ok) throw new Error("Failed to load bankroll");
      setBankroll(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { load(selectedDate); }, [selectedDate, load]);

  const saveUnitSize = async () => {
    const val = parseFloat(unitInput);
    if (!isFinite(val) || val <= 0) return;
    await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitSize: val }),
    });
    setEditingUnit(false);
    load(selectedDate);
  };

  const prevDate = shiftDay(selectedDate, -1);
  const nextDate = shiftDay(selectedDate, 1);
  const canGoPrev = prevDate >= firstDate;
  const canGoNext = nextDate <= todayYYYYMMDD() || (bankroll?.availableDates ?? []).includes(nextDate);

  const day = bankroll?.dayData;
  const profitColor = (n: number) =>
    n > 0 ? "text-green-400" : n < 0 ? "text-red-400" : "text-gray-400";

  return (
    <div>
      {/* Source badge */}
      <div className="flex items-center gap-2 mb-4">
        <span className={`text-[10px] font-bold uppercase tracking-widest ${sourceAccent}`}>
          {sourceLabel} bankroll
        </span>
        <span className="text-[10px] text-gray-600">·</span>
        <span className="text-[10px] text-gray-500">
          Switch market source via the toggle in the top nav.
        </span>
      </div>

      {/* Overall bankroll summary */}
      {bankroll && !loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <StatCard
            label="Current Balance"
            value={dollar(bankroll.currentBalance)}
            sub={`Started: ${dollar(bankroll.startingBalance)}`}
            color={bankroll.currentBalance >= bankroll.startingBalance ? "text-green-400" : "text-red-400"}
          />
          <StatCard
            label="Total Profit"
            value={dollar(bankroll.totalProfit, true)}
            sub={`${bankroll.totalProfitPct >= 0 ? "+" : ""}${bankroll.totalProfitPct.toFixed(1)}% ROI`}
            color={profitColor(bankroll.totalProfit)}
          />
          <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-xl px-4 py-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Unit Size</div>
            {editingUnit ? (
              <div className="flex items-center gap-1 mt-1">
                <span className="text-gray-400 text-sm">$</span>
                <input
                  className="w-16 bg-[#0e1016] border border-[#3a3d45] text-white text-sm rounded px-1.5 py-0.5 outline-none"
                  value={unitInput}
                  onChange={(e) => setUnitInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveUnitSize(); if (e.key === "Escape") setEditingUnit(false); }}
                  autoFocus
                />
                <button onClick={saveUnitSize} className="text-green-400 hover:text-green-300"><Check className="w-3.5 h-3.5" /></button>
                <button onClick={() => setEditingUnit(false)} className="text-gray-500 hover:text-gray-300"><X className="w-3.5 h-3.5" /></button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xl font-bold text-white">${bankroll.unitSize}</span>
                <button
                  onClick={() => { setUnitInput(String(bankroll.unitSize)); setEditingUnit(true); }}
                  className="text-gray-600 hover:text-gray-400 transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            )}
            <div className="text-[10px] text-gray-600 mt-0.5">per unit · changes future bets</div>
          </div>
          <StatCard
            label="All Bets"
            value={String(bankroll.bets.length)}
            sub={`${bankroll.bets.filter((b) => b.status === "pending").length} pending`}
          />
        </div>
      )}

      {/* Date navigation */}
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

      {loading && (
        <div className="flex flex-col gap-3">
          {[...Array(3)].map((_, i) => <div key={i} className="bg-[#1a1d24] border border-[#2a2d35] rounded-xl h-14 animate-pulse" />)}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-900/20 border border-red-800/40 rounded-xl px-4 py-3 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {!loading && !error && bankroll && (
        <>
          {/* Day summary cards */}
          {day && (
            <div className="grid grid-cols-3 gap-3 mb-5">
              <StatCard
                label="Day Started"
                value={dollar(day.startingBalance)}
                sub="balance at start of day"
              />
              <StatCard
                label="Day P&L"
                value={dollar(day.dayProfit, true)}
                sub={`${day.settledCount} settled · ${day.pendingCount} pending`}
                color={profitColor(day.dayProfit)}
              />
              <StatCard
                label="Picks Today"
                value={String(day.bets.length)}
                sub={`$${day.totalBetAmount.toFixed(2)} wagered`}
              />
            </div>
          )}

          {/* Bets table */}
          <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl overflow-hidden">
            {!day || day.bets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-500">
                <DollarSign className="w-10 h-10 text-gray-700 mb-3" />
                <p className="text-sm font-medium">No value plays on this date</p>
                <p className="text-xs mt-1 text-gray-600">Run Value Plays to start tracking mock bets</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[#2a2d35]">
                      {["Game", "Market", "Pick", "Confidence", "Units", "Bet $", "Odds", "Status", "P&L"].map((h) => (
                        <th key={h} className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-gray-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {day.bets.map((bet) => <BetRow key={bet.recId} bet={bet} />)}
                  </tbody>
                  {day.bets.length > 0 && (
                    <tfoot>
                      <tr className="border-t border-[#2a2d35] bg-[#111318]">
                        <td colSpan={5} className="px-3 py-2 text-[10px] text-gray-600 font-bold uppercase tracking-wider">
                          Day Total
                        </td>
                        <td className="px-3 py-2 text-[11px] font-bold text-gray-300">
                          {dollar(day.totalBetAmount)}
                        </td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-[10px] text-gray-500">
                          {day.settledCount}/{day.bets.length} settled
                        </td>
                        <td className={`px-3 py-2 text-xs font-bold tabular-nums ${profitColor(day.dayProfit)}`}>
                          {dollar(day.dayProfit, true)}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>

          {/* Unit sizing guide */}
          <div className="mt-4 bg-[#1a1d24] border border-[#2a2d35] rounded-xl px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Unit Sizing (Confidence → Units)</div>
            <div className="flex gap-4 text-[11px] text-gray-400">
              <span><span className="text-yellow-500 font-semibold">1-4:</span> 0.5u · ${(bankroll.unitSize * 0.5).toFixed(2)}</span>
              <span><span className="text-blue-400 font-semibold">5-6:</span> 1.0u · ${(bankroll.unitSize * 1).toFixed(2)}</span>
              <span><span className="text-blue-300 font-semibold">7-8:</span> 1.5u · ${(bankroll.unitSize * 1.5).toFixed(2)}</span>
              <span><span className="text-green-400 font-semibold">9-10:</span> 2.0u · ${(bankroll.unitSize * 2).toFixed(2)}</span>
            </div>
          </div>

          {/* Grade pending nudge if needed */}
          {bankroll.bets.some((b) => b.status === "pending") && (
            <div className="mt-3 flex items-center justify-between bg-yellow-900/10 border border-yellow-800/20 rounded-xl px-4 py-3">
              <p className="text-xs text-yellow-400/80">
                {bankroll.bets.filter((b) => b.status === "pending").length} pending bets — grade them to update P&L
              </p>
              <button
                onClick={onGrade}
                disabled={grading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-900/30 border border-yellow-800/40 hover:border-yellow-700/60 text-yellow-400 text-xs rounded-lg transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${grading ? "animate-spin" : ""}`} />
                {grading ? "Grading…" : "Grade Now"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Stats tab ─────────────────────────────────────────────────────────────────

function StatsTab({
  breakdown,
  recs,
  total,
  loading,
  error,
  leagueFilter,
  marketFilter,
  setLeagueFilter,
  setMarketFilter,
}: {
  breakdown: PerformanceBreakdown | null;
  recs: TrackedRecommendation[];
  total: number;
  loading: boolean;
  error: string | null;
  leagueFilter: League | "All";
  marketFilter: MarketType | "All";
  setLeagueFilter: (l: League | "All") => void;
  setMarketFilter: (m: MarketType | "All") => void;
}) {
  const overall = breakdown?.overall;
  const hasData = !!overall && (overall.wins + overall.losses + overall.pushes + overall.pending) > 0;

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="flex gap-1">
          {(["All", "MLB", "WNBA"] as const).map((l) => (
            <button key={l} onClick={() => setLeagueFilter(l)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${leagueFilter === l ? "bg-blue-600 text-white" : "bg-[#1a1d24] border border-[#2a2d35] text-gray-400 hover:text-gray-200"}`}>{l}</button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["All", "moneyline", "spread", "total"] as const).map((m) => (
            <button key={m} onClick={() => setMarketFilter(m)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors capitalize ${marketFilter === m ? "bg-blue-600 text-white" : "bg-[#1a1d24] border border-[#2a2d35] text-gray-400 hover:text-gray-200"}`}>{m}</button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex flex-col gap-3">
          {[...Array(3)].map((_, i) => <div key={i} className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl h-20 animate-pulse" />)}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-900/20 border border-red-800/40 rounded-2xl px-6 py-4 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {!loading && !error && !hasData && (
        <div className="flex flex-col items-center justify-center py-24 text-gray-500">
          <Trophy className="w-12 h-12 text-gray-700 mb-4" />
          <p className="text-lg font-medium">No recommendations tracked yet</p>
          <p className="text-sm mt-1 text-center max-w-sm text-gray-600">
            Run the Value Plays tab to let Claude analyze games. Any identified value plays will be automatically saved here.
          </p>
        </div>
      )}

      {!loading && !error && hasData && breakdown && overall && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <StatCard label="Record" value={`${overall.wins}W-${overall.losses}L${overall.pushes > 0 ? `-${overall.pushes}P` : ""}`} sub={`${pct(overall.winRate)} win rate`} />
            <StatCard label="Units P&L" value={units(overall.unitsPL)} sub={`${roi(overall.roi)} ROI`} color={overall.unitsPL > 0 ? "text-green-400" : overall.unitsPL < 0 ? "text-red-400" : "text-gray-400"} />
            <StatCard label="Total Tracked" value={String(total)} sub={`${overall.pending} pending`} />
            <StatCard
              label="Avg Conf (W/L)"
              value={breakdown.avgConfidenceWins != null && breakdown.avgConfidenceLosses != null
                ? `${breakdown.avgConfidenceWins.toFixed(1)} / ${breakdown.avgConfidenceLosses.toFixed(1)}`
                : "—"}
              sub="wins / losses"
            />
          </div>

          <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">By League</h2>
          <div className="grid grid-cols-2 gap-3 mb-5">
            <RecordCard label="MLB" stats={breakdown.byLeague.MLB} />
            <RecordCard label="WNBA" stats={breakdown.byLeague.WNBA} />
          </div>

          <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">By Market</h2>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <RecordCard label="Moneyline" stats={breakdown.byMarket.moneyline} />
            <RecordCard label="Spread" stats={breakdown.byMarket.spread} />
            <RecordCard label="Total" stats={breakdown.byMarket.total} />
          </div>

          <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">By Confidence Tier</h2>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <RecordCard label="High (8-10)" stats={breakdown.byConfidence.high} highlight />
            <RecordCard label="Medium (6-7)" stats={breakdown.byConfidence.medium} />
            <RecordCard label="Low (1-5)" stats={breakdown.byConfidence.low} />
          </div>

          <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">By Claude Rating</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <RecordCard label="Safe" stats={breakdown.byRating.safe} />
            <RecordCard label="Lean" stats={breakdown.byRating.lean} />
            <RecordCard label="Risky" stats={breakdown.byRating.risky} />
            <RecordCard label="Avoid" stats={breakdown.byRating.avoid} />
          </div>

          <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
            Recommendation History ({recs.length} shown)
          </h2>
          <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl overflow-hidden">
            {recs.length === 0 ? (
              <p className="text-gray-600 text-xs text-center py-8">No recommendations match the current filter.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[#2a2d35]">
                      {["Date", "Game", "Market", "Pick", "Price", "Confidence", "Rating", "Status", "Score"].map((h) => (
                        <th key={h} className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-gray-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recs.map((rec) => <RecommendationRow key={rec.id} rec={rec} />)}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PerformanceClient() {
  const { source } = useDataSource();
  const [activeTab, setActiveTab] = useState<"bankroll" | "stats">("bankroll");
  const [breakdown, setBreakdown] = useState<PerformanceBreakdown | null>(null);
  const [recs, setRecs] = useState<TrackedRecommendation[]>([]);
  const [total, setTotal] = useState(0);
  const [statsLoading, setStatsLoading] = useState(true);
  const [grading, setGrading] = useState(false);
  const [gradingResult, setGradingResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leagueFilter, setLeagueFilter] = useState<League | "All">("All");
  const [marketFilter, setMarketFilter] = useState<MarketType | "All">("All");
  // Used by BankrollTab to trigger a reload after grading
  const [gradeKey, setGradeKey] = useState(0);

  const loadStats = useCallback(async (
    league: League | undefined,
    market: MarketType | undefined,
    src: string
  ) => {
    setStatsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "200", source: src });
      if (league) params.set("league", league);
      if (market) params.set("market", market);
      const res = await fetch(`/api/performance?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setBreakdown(data.breakdown);
      setRecs(data.recommendations ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const gradeNow = async () => {
    setGrading(true);
    setGradingResult(null);
    try {
      const endpoint =
        source === "kalshi" ? "/api/kalshi-grade-recommendations" : "/api/grade-recommendations";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      setGradingResult(`Graded ${data.graded} of ${data.pending} pending ${source} picks`);
      await loadStats(
        leagueFilter !== "All" ? leagueFilter : undefined,
        marketFilter !== "All" ? marketFilter : undefined,
        source
      );
      setGradeKey((k) => k + 1); // tells BankrollTab to reload
    } catch {
      setGradingResult("Grading failed");
    } finally {
      setGrading(false);
    }
  };

  useEffect(() => {
    loadStats(
      leagueFilter !== "All" ? leagueFilter : undefined,
      marketFilter !== "All" ? marketFilter : undefined,
      source
    );
  }, [leagueFilter, marketFilter, source, loadStats]);

  return (
    <div className="min-h-screen" style={{ background: "#111318" }}>
      <div className="max-w-5xl mx-auto px-4 pt-8 pb-16">

        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="flex items-center gap-2">
              <Trophy className="w-7 h-7 text-yellow-500" />
              <h1 className="text-4xl font-bold text-white">Claude Performance</h1>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              Mock $100 bankroll · value play tracking · past performance does not guarantee future results
            </p>
          </div>
          <button
            onClick={gradeNow}
            disabled={grading}
            className="flex items-center gap-2 px-4 py-2 bg-[#1a1d24] border border-[#2a2d35] hover:border-[#3a3d45] text-gray-300 text-sm rounded-xl transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${grading ? "animate-spin" : ""}`} />
            {grading ? "Grading..." : "Grade Pending"}
          </button>
        </div>

        {gradingResult && (
          <p className="text-xs text-blue-400 mb-4">{gradingResult}</p>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6">
          <button
            onClick={() => setActiveTab("bankroll")}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${activeTab === "bankroll" ? "bg-green-600/20 border border-green-700/40 text-green-400" : "bg-[#1a1d24] border border-[#2a2d35] text-gray-400 hover:text-gray-200"}`}
          >
            <TrendingUp className="w-4 h-4" /> Mock Bankroll
          </button>
          <button
            onClick={() => setActiveTab("stats")}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${activeTab === "stats" ? "bg-blue-600/20 border border-blue-700/40 text-blue-400" : "bg-[#1a1d24] border border-[#2a2d35] text-gray-400 hover:text-gray-200"}`}
          >
            <TrendingDown className="w-4 h-4" /> Win/Loss Stats
          </button>
        </div>

        {activeTab === "bankroll" && (
          // key includes source so swapping the toggle remounts cleanly
          <BankrollTab
            key={`${source}-${gradeKey}`}
            source={source}
            onGrade={gradeNow}
            grading={grading}
          />
        )}

        {activeTab === "stats" && (
          <StatsTab
            breakdown={breakdown}
            recs={recs}
            total={total}
            loading={statsLoading}
            error={error}
            leagueFilter={leagueFilter}
            marketFilter={marketFilter}
            setLeagueFilter={setLeagueFilter}
            setMarketFilter={setMarketFilter}
          />
        )}
      </div>
    </div>
  );
}
