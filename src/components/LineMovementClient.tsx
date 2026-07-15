"use client";

import { useState, useEffect, useCallback } from "react";
import { Activity, ChevronDown, RefreshCw } from "lucide-react";
import { GameMovement } from "@/types/snapshots";
import LineMovementCard from "./LineMovementCard";

type League = "All" | "MLB" | "WNBA";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function displayDate(s: string) {
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" });
}

function shiftDate(s: string, n: number) {
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function inputVal(s: string) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export default function LineMovementClient() {
  const [date, setDate] = useState(todayStr);
  const [league, setLeague] = useState<League>("All");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [movements, setMovements] = useState<GameMovement[]>([]);
  const [snapshotCountByGame, setSnapshotCountByGame] = useState<Record<string, number>>({});
  const [totalSnapshots, setTotalSnapshots] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const load = useCallback(async (d: string, l: League) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ date: d });
      if (l !== "All") params.set("league", l);
      const res = await fetch(`/api/line-movement?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setMovements(data.movements ?? []);
      setSnapshotCountByGame(data.snapshotCountByGame ?? {});
      setTotalSnapshots(data.totalSnapshots ?? 0);
      setLastUpdated(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The effect synchronizes the selected filters with the remote feed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(date, league);
  }, [date, league, load]);

  // Sort: games with most movement first
  const sorted = [...movements].sort((a, b) => {
    const maxMove = (m: GameMovement) =>
      Math.max(...(["moneyline", "spread", "total"] as const).flatMap((mt) =>
        (m.markets[mt] ?? []).map((h) => Math.abs(h.changeFromOpen))
      ));
    return maxMove(b) - maxMove(a);
  });

  return (
    <div className="min-h-screen" style={{ background: "#111318" }}>
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-16">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-4xl font-bold text-white">Line Movement</h1>
            <p className="text-sm text-gray-500 mt-1">
              Polymarket price history — automatically captured as you use the app
            </p>
          </div>
          <Activity className="w-8 h-8 text-blue-500 mt-1" />
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          {/* Prev/Next date */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDate((d) => shiftDate(d, -1))}
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#1a1d24] border border-[#2a2d35] hover:bg-[#252a3a] text-gray-400 text-sm"
            >‹</button>
            <div className="relative">
              <button
                onClick={() => setShowDatePicker((v) => !v)}
                className="flex items-center gap-1.5 bg-[#1a1d24] border border-[#2a2d35] text-gray-300 text-sm rounded-lg px-3 py-1.5 hover:border-[#3a3d45]"
              >
                {displayDate(date)}
                <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
              </button>
              {showDatePicker && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-[#1a1d24] border border-[#2a2d35] rounded-xl p-2 shadow-2xl">
                  <input
                    type="date"
                    value={inputVal(date)}
                    onChange={(e) => { setDate(e.target.value.replace(/-/g, "")); setShowDatePicker(false); }}
                    className="bg-transparent text-white text-sm outline-none cursor-pointer"
                  />
                </div>
              )}
            </div>
            <button
              onClick={() => setDate((d) => shiftDate(d, 1))}
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#1a1d24] border border-[#2a2d35] hover:bg-[#252a3a] text-gray-400 text-sm"
            >›</button>
          </div>

          {/* League filter */}
          <div className="flex gap-1">
            {(["All", "MLB", "WNBA"] as League[]).map((l) => (
              <button
                key={l}
                onClick={() => setLeague(l)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  league === l ? "bg-blue-600 text-white" : "bg-[#1a1d24] border border-[#2a2d35] text-gray-400 hover:text-gray-200"
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-3">
            {lastUpdated && (
              <span className="text-[10px] text-gray-600">Updated {lastUpdated}</span>
            )}
            <button
              onClick={() => load(date, league)}
              className="p-1.5 rounded-lg bg-[#1a1d24] border border-[#2a2d35] hover:bg-[#252a3a] text-gray-400 hover:text-gray-200 transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Stats bar */}
        {totalSnapshots > 0 && (
          <div className="flex items-center gap-4 mb-4 text-xs text-gray-600">
            <span>{totalSnapshots} total snapshots</span>
            <span>·</span>
            <span>{movements.length} game{movements.length !== 1 ? "s" : ""} tracked</span>
          </div>
        )}

        {/* Loading skeletons */}
        {loading && (
          <div className="flex flex-col gap-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl h-40 animate-pulse" />
            ))}
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="bg-red-900/20 border border-red-800/40 rounded-2xl px-6 py-6 text-center">
            <p className="text-red-400 font-medium">{error}</p>
            <button onClick={() => load(date, league)} className="mt-3 text-sm text-gray-400 underline">
              Retry
            </button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <Activity className="w-12 h-12 text-gray-700 mb-4" />
            <p className="text-lg font-medium">No movement data yet</p>
            <p className="text-sm mt-1 text-center max-w-sm text-gray-600">
              Prices are captured automatically when you view the MLB or WNBA games pages.
              Visit those pages a few times to start building history.
            </p>
          </div>
        )}

        {/* Cards */}
        {!loading && sorted.length > 0 && (
          <div className="flex flex-col gap-3">
            {sorted.map((m) => (
              <LineMovementCard
                key={m.gameId}
                movement={m}
                snapshotCount={snapshotCountByGame[m.gameId] ?? 0}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
