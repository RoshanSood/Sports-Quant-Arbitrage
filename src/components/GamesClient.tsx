"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, SlidersHorizontal, ChevronDown } from "lucide-react";
import GameCard from "./GameCard";
import { MLBGame } from "@/types";
import { useDataSource } from "./DataSourceContext";

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  // dateStr: YYYYMMDD
  const y = dateStr.slice(0, 4);
  const m = dateStr.slice(4, 6);
  const d = dateStr.slice(6, 8);
  const date = new Date(`${y}-${m}-${d}T12:00:00`);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" });
}

function inputDateValue(dateStr: string): string {
  // YYYYMMDD -> YYYY-MM-DD for <input type="date">
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

export default function GamesClient() {
  const { source } = useDataSource();
  const [activeTab, setActiveTab] = useState<"games" | "props">("games");
  const [date, setDate] = useState(todayDateStr);
  const [games, setGames] = useState<MLBGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);

  const loadGames = useCallback(async (d: string, src: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/games?date=${d}&source=${src}`);
      const data = await res.json();
      if (data.error && !data.games?.length) {
        setError(data.error);
      }
      setGames(data.games || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load games");
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The effect synchronizes the selected date/source with the remote feed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadGames(date, source);
  }, [date, source, loadGames]);

  const filteredGames = games.filter((g) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      g.awayTeam.name.toLowerCase().includes(q) ||
      g.awayTeam.shortName.toLowerCase().includes(q) ||
      g.homeTeam.name.toLowerCase().includes(q) ||
      g.homeTeam.shortName.toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen" style={{ background: "#111318" }}>
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-16">

        {/* Page header */}
        <div className="flex items-start justify-between mb-6">
          <h1 className="text-4xl font-bold text-white">MLB</h1>
          <button className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-[#1e2130] transition-colors">
            <SlidersHorizontal className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs + search + date row */}
        <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
          {/* Tabs */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab("games")}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${
                activeTab === "games"
                  ? "bg-blue-500 text-white"
                  : "text-gray-400 hover:text-white hover:bg-[#1e2130]"
              }`}
            >
              Games
            </button>
            <button
              onClick={() => setActiveTab("props")}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${
                activeTab === "props"
                  ? "bg-blue-500 text-white"
                  : "text-gray-400 hover:text-white hover:bg-[#1e2130]"
              }`}
            >
              Props
            </button>
          </div>

          {/* Search + Date */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                placeholder="Search teams..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-[#1a1d24] border border-[#2a2d35] text-white text-sm rounded-lg pl-9 pr-4 py-2 outline-none focus:border-blue-500 w-44 placeholder:text-gray-600"
              />
            </div>

            {/* Date selector */}
            <div className="relative">
              <button
                onClick={() => setShowDatePicker(!showDatePicker)}
                className="flex items-center gap-2 bg-[#1a1d24] border border-[#2a2d35] text-gray-300 text-sm rounded-lg px-4 py-2 hover:border-[#3a3d45] transition-colors"
              >
                {formatDisplayDate(date)}
                <ChevronDown className="w-4 h-4 text-gray-500" />
              </button>
              {showDatePicker && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-[#1a1d24] border border-[#2a2d35] rounded-xl p-2 shadow-2xl">
                  <input
                    type="date"
                    value={inputDateValue(date)}
                    onChange={(e) => {
                      const val = e.target.value.replace(/-/g, "");
                      setDate(val);
                      setShowDatePicker(false);
                    }}
                    className="bg-transparent text-white text-sm outline-none cursor-pointer"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Props placeholder */}
        {activeTab === "props" && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <p className="text-lg font-medium">Props coming soon</p>
            <p className="text-sm mt-1">Switch to Games to see today&apos;s matchups.</p>
          </div>
        )}

        {/* Games content */}
        {activeTab === "games" && (
          <>
            {/* Date label */}
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                {formatDisplayDate(date)}
              </h2>
            </div>

            {/* Column headers */}
            <div className="hidden md:flex items-center px-4 mb-2">
              <div className="flex-1" />
              <div className="w-[90px] text-center text-[10px] font-bold tracking-widest text-gray-500 uppercase">
                Moneyline
              </div>
              <div className="w-[90px] text-center text-[10px] font-bold tracking-widest text-gray-500 uppercase">
                Spread
              </div>
              <div className="w-[90px] text-center text-[10px] font-bold tracking-widest text-gray-500 uppercase">
                Total
              </div>
              <div className="w-[110px]" />
            </div>

            {/* Loading */}
            {loading && (
              <div className="flex flex-col gap-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl h-28 animate-pulse" />
                ))}
              </div>
            )}

            {/* Error */}
            {!loading && error && (
              <div className="bg-red-900/20 border border-red-800/40 rounded-2xl px-6 py-8 text-center">
                <p className="text-red-400 font-medium">Failed to load games</p>
                <p className="text-gray-500 text-sm mt-1">{error}</p>
                <button
                  onClick={() => loadGames(date, source)}
                  className="mt-4 px-4 py-2 bg-[#1a1d24] border border-[#2a2d35] text-gray-300 text-sm rounded-lg hover:border-gray-500 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Empty */}
            {!loading && !error && filteredGames.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-gray-500">
                <p className="text-lg font-medium">
                  {search ? `No games found matching "${search}"` : "No games scheduled"}
                </p>
                <p className="text-sm mt-1">
                  {search ? "Try a different search term" : "Check back later or select a different date"}
                </p>
              </div>
            )}

            {/* Game cards */}
            {!loading && filteredGames.length > 0 && (
              <div className="flex flex-col gap-3">
                {filteredGames.map((game) => (
                  <GameCard key={game.id} game={game} gameDate={formatDisplayDate(date)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
