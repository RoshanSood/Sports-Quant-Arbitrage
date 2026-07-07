"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown, TrendingUp, RefreshCw, Lock, Clock } from "lucide-react";
import { ValuePlay, ValuePlaysCacheEntry } from "@/types/analysis";
import ValuePlayCard from "./ValuePlayCard";
import { useDataSource } from "./DataSourceContext";

type League = "All" | "MLB" | "WNBA";
type MarketFilter = "All" | "moneyline" | "spread" | "total";

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(s: string) {
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" });
}

function inputDateValue(s: string) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function timeAgo(isoStr: string): string {
  const secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function ValuePlaysClient() {
  const { source } = useDataSource();
  const [date, setDate] = useState(todayDateStr);
  const [league, setLeague] = useState<League>("All");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("All");
  const [minConfidence, setMinConfidence] = useState(6);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [entry, setEntry] = useState<ValuePlaysCacheEntry | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [loading, setLoading] = useState(true);

  // Admin panel
  const [showAdmin, setShowAdmin] = useState(false);
  const [password, setPassword] = useState("");
  const [adminMsg, setAdminMsg] = useState("");

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCached = useCallback(async (d: string, src: string) => {
    const res = await fetch(`/api/value-plays/cached?date=${d}&source=${src}`);
    const data: { entry: ValuePlaysCacheEntry | null; running: boolean } = await res.json();
    setEntry(data.entry ?? null);
    setServerRunning(data.running ?? false);
    return data;
  }, []);

  // Load on date or source change
  useEffect(() => {
    setLoading(true);
    setEntry(null);
    setServerRunning(false);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);

    fetchCached(date, source).finally(() => setLoading(false));
  }, [date, source, fetchCached]);

  // Poll every 5 seconds while server-side analysis is running
  useEffect(() => {
    if (!serverRunning) return;

    const poll = async () => {
      const data = await fetchCached(date, source);
      if (data.running) {
        pollTimerRef.current = setTimeout(poll, 5000);
      }
    };
    pollTimerRef.current = setTimeout(poll, 5000);

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [serverRunning, date, source, fetchCached]);

  const triggerRun = async () => {
    if (password !== "123") {
      setAdminMsg("Wrong password.");
      return;
    }
    setAdminMsg("Starting analysis...");
    try {
      const res = await fetch("/api/value-plays/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, source, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setAdminMsg(
          data.status === "already-running"
            ? "Already running — results will appear when complete."
            : "Analysis started! Results will appear automatically."
        );
        setServerRunning(true);
        setPassword("");
        setShowAdmin(false);
      } else {
        setAdminMsg(data.error ?? "Error starting analysis.");
      }
    } catch {
      setAdminMsg("Network error.");
    }
  };

  // Client-side filters on cached plays
  const allPlays: ValuePlay[] = entry?.plays ?? [];
  const displayed = allPlays.filter(
    (p) =>
      (league === "All" || p.league === league) &&
      (marketFilter === "All" || p.market === marketFilter) &&
      p.analysis.confidence >= minConfidence
  );

  return (
    <div className="min-h-screen" style={{ background: "#111318" }}>
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-16">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-4xl font-bold text-white">Value Plays</h1>
            <p className="text-sm text-gray-500 mt-1">
              {entry
                ? `Updated ${timeAgo(entry.generatedAt)} · ${entry.analyzedCount} of ${entry.gameCount} games analyzed`
                : "Updated nightly at 9:57 PM PT for the next day"}
            </p>
          </div>
          <TrendingUp className="w-8 h-8 text-blue-500 mt-1" />
        </div>

        {/* Controls */}
        <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl p-4 mb-6">
          <div className="flex flex-wrap gap-4 items-end">

            {/* Date */}
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Date</div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setDate((d) => shiftDate(d, -1))}
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#252a3a] hover:bg-[#2d3348] text-gray-400 text-sm transition-colors"
                >‹</button>
                <div className="relative">
                  <button
                    onClick={() => setShowDatePicker(!showDatePicker)}
                    className="flex items-center gap-1.5 bg-[#252a3a] text-gray-300 text-sm rounded-lg px-3 py-1.5 hover:bg-[#2d3348] transition-colors"
                  >
                    {formatDisplayDate(date)}
                    <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
                  </button>
                  {showDatePicker && (
                    <div className="absolute left-0 top-full mt-1 z-50 bg-[#1a1d24] border border-[#2a2d35] rounded-xl p-2 shadow-2xl">
                      <input
                        type="date"
                        value={inputDateValue(date)}
                        onChange={(e) => {
                          setDate(e.target.value.replace(/-/g, ""));
                          setShowDatePicker(false);
                        }}
                        className="bg-transparent text-white text-sm outline-none cursor-pointer"
                      />
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setDate((d) => shiftDate(d, 1))}
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#252a3a] hover:bg-[#2d3348] text-gray-400 text-sm transition-colors"
                >›</button>
              </div>
            </div>

            {/* League */}
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">League</div>
              <div className="flex gap-1">
                {(["All", "MLB", "WNBA"] as League[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLeague(l)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      league === l ? "bg-blue-600 text-white" : "bg-[#252a3a] text-gray-400 hover:text-gray-200"
                    }`}
                  >{l}</button>
                ))}
              </div>
            </div>

            {/* Market */}
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Market</div>
              <div className="flex gap-1">
                {(["All", "moneyline", "spread", "total"] as MarketFilter[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMarketFilter(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors capitalize ${
                      marketFilter === m ? "bg-blue-600 text-white" : "bg-[#252a3a] text-gray-400 hover:text-gray-200"
                    }`}
                  >{m}</button>
                ))}
              </div>
            </div>

            {/* Min confidence */}
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Min Confidence</div>
              <div className="flex gap-1">
                {[5, 6, 7, 8].map((c) => (
                  <button
                    key={c}
                    onClick={() => setMinConfidence(c)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      minConfidence === c ? "bg-blue-600 text-white" : "bg-[#252a3a] text-gray-400 hover:text-gray-200"
                    }`}
                  >{c}+</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Running banner */}
        {serverRunning && (
          <div className="flex items-center gap-2 text-blue-400 text-sm bg-blue-950/30 border border-blue-800/30 rounded-xl px-4 py-3 mb-4">
            <RefreshCw className="w-4 h-4 animate-spin flex-shrink-0" />
            Analysis in progress — results will appear automatically when complete...
          </div>
        )}

        {/* Loading */}
        {loading && !serverRunning && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <RefreshCw className="w-8 h-8 text-gray-700 mb-3 animate-spin" />
            <p className="text-sm">Loading...</p>
          </div>
        )}

        {/* No cache */}
        {!loading && !entry && !serverRunning && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <Clock className="w-12 h-12 text-gray-700 mb-4" />
            <p className="text-lg font-medium">No analysis for this date yet</p>
            <p className="text-sm mt-1 text-center max-w-sm">
              Value plays are generated automatically at midnight PST each day.
            </p>
          </div>
        )}

        {/* Results */}
        {!loading && entry && displayed.length === 0 && !serverRunning && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <p className="text-lg font-medium">No value plays match your filters</p>
            <p className="text-sm mt-1">
              {allPlays.length > 0
                ? `${allPlays.length} play(s) found but filtered by current settings`
                : "No clear edges found in this day's markets"}
            </p>
            {allPlays.length > 0 && (
              <button
                onClick={() => { setMarketFilter("All"); setMinConfidence(5); }}
                className="mt-3 text-xs text-blue-400 hover:text-blue-300 underline"
              >
                Lower filters
              </button>
            )}
          </div>
        )}

        {displayed.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                {displayed.length} Value Play{displayed.length !== 1 ? "s" : ""} Found
              </h2>
              {serverRunning && (
                <span className="text-xs text-blue-400 animate-pulse flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 animate-spin" /> Refreshing
                </span>
              )}
            </div>
            <div className="flex flex-col gap-3">
              {displayed.map((play, i) => (
                <ValuePlayCard key={`${play.gameId}-${play.market}-${i}`} play={play} />
              ))}
            </div>
          </>
        )}

        {/* Admin panel */}
        <div className="mt-12 border-t border-[#1e2130] pt-6">
          <button
            onClick={() => { setShowAdmin((v) => !v); setAdminMsg(""); }}
            className="flex items-center gap-1.5 text-gray-600 hover:text-gray-400 text-xs transition-colors"
          >
            <Lock className="w-3 h-3" />
            Admin refresh
          </button>

          {showAdmin && (
            <div className="mt-3 bg-[#1a1d24] border border-[#2a2d35] rounded-xl p-4 max-w-sm">
              <p className="text-xs text-gray-500 mb-3">
                Re-runs value plays for {formatDisplayDate(date)} ({source}). Uses Anthropic API credits.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && triggerRun()}
                  placeholder="Password"
                  className="flex-1 bg-[#252a3a] text-white text-sm rounded-lg px-3 py-1.5 outline-none border border-[#2a2d35] focus:border-blue-500"
                />
                <button
                  onClick={triggerRun}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-semibold transition-colors"
                >
                  Run
                </button>
              </div>
              {adminMsg && (
                <p className={`text-xs mt-2 ${
                  adminMsg.includes("Error") || adminMsg.includes("Wrong") || adminMsg.includes("Network")
                    ? "text-red-400"
                    : "text-green-400"
                }`}>
                  {adminMsg}
                </p>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
