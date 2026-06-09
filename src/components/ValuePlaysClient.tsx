"use client";

import { useState, useCallback, useRef } from "react";
import { ChevronDown, TrendingUp, RefreshCw } from "lucide-react";
import { MLBGame } from "@/types";
import { WNBAGame } from "@/types/wnba";
import { GameAnalysis, ValuePlay } from "@/types/analysis";
import { extractValuePlays } from "@/lib/valuePlayAnalysis";
import ValuePlayCard from "./ValuePlayCard";
import { useDataSource } from "./DataSourceContext";

type League = "All" | "MLB" | "WNBA";
type MarketFilter = "All" | "moneyline" | "spread" | "total";

type GameEntry =
  | { league: "MLB"; game: MLBGame }
  | { league: "WNBA"; game: WNBAGame };

type AnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; analysis: GameAnalysis }
  | { status: "error"; message: string };

const CONCURRENCY = 3;

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

// Session-level analysis cache (keyed by source so toggling re-runs)
const analysisCache = new Map<string, GameAnalysis>();

async function analyzeGame(
  entry: GameEntry,
  gameDate: string,
  source: string
): Promise<GameAnalysis> {
  const cacheKey = `${source}-${entry.league}-${entry.game.id}-${gameDate}`;
  if (analysisCache.has(cacheKey)) return analysisCache.get(cacheKey)!;

  const res = await fetch(`/api/value-play/${entry.game.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ league: entry.league, game: entry.game, gameDate, source }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.analysis) throw new Error("No analysis in response");
  analysisCache.set(cacheKey, data.analysis);
  return data.analysis;
}

async function processQueue<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
) {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export default function ValuePlaysClient() {
  const { source } = useDataSource();
  const [date, setDate] = useState(todayDateStr);
  const [league, setLeague] = useState<League>("All");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("All");
  const [minConfidence, setMinConfidence] = useState(6);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [states, setStates] = useState<Map<string, AnalysisState>>(new Map());
  const [valuePlays, setValuePlays] = useState<ValuePlay[]>([]);
  const abortRef = useRef(false);

  const setGameState = useCallback((id: string, state: AnalysisState) => {
    setStates((prev) => new Map(prev).set(id, state));
  }, []);

  const runAnalysis = useCallback(async () => {
    abortRef.current = false;
    analysisCache.clear();
    setRunning(true);
    setStates(new Map());
    setValuePlays([]);
    setProgress({ done: 0, total: 0 });

    try {
      // Fetch games for selected leagues
      const fetches: Promise<GameEntry[]>[] = [];

      if (league === "All" || league === "MLB") {
        fetches.push(
          fetch(`/api/games?date=${date}&source=${source}`)
            .then((r) => r.json())
            .then((d) => (d.games as MLBGame[]).map((g) => ({ league: "MLB" as const, game: g })))
            .catch(() => [])
        );
      }
      if ((league === "All" || league === "WNBA") && source !== "kalshi") {
        fetches.push(
          fetch(`/api/wnba?date=${date}&source=${source}`)
            .then((r) => r.json())
            .then((d) => (d.games as WNBAGame[]).map((g) => ({ league: "WNBA" as const, game: g })))
            .catch(() => [])
        );
      }

      const results = await Promise.all(fetches);
      const allGames: GameEntry[] = results.flat();

      if (allGames.length === 0) {
        setRunning(false);
        return;
      }

      setProgress({ done: 0, total: allGames.length });

      // Mark all as loading
      const initial = new Map<string, AnalysisState>();
      for (const e of allGames) initial.set(e.game.id, { status: "loading" });
      setStates(initial);

      const collectedPlays: ValuePlay[] = [];

      await processQueue(allGames, CONCURRENCY, async (entry) => {
        if (abortRef.current) return;
        try {
          const analysis = await analyzeGame(entry, date, source);
          setGameState(entry.game.id, { status: "done", analysis });

          // Extract value plays from this game
          const { awayTeam, homeTeam, startTime } = entry.game as MLBGame & WNBAGame;
          const plays = extractValuePlays(
            analysis,
            { name: awayTeam.name, abbreviation: awayTeam.abbreviation },
            { name: homeTeam.name, abbreviation: homeTeam.abbreviation },
            startTime,
            minConfidence
          );

          if (plays.length > 0) {
            setValuePlays((prev) => {
              const updated = [...prev, ...plays];
              // Sort by confidence descending
              return updated.sort((a, b) => b.analysis.confidence - a.analysis.confidence);
            });
            collectedPlays.push(...plays);
          }
        } catch (err) {
          setGameState(entry.game.id, {
            status: "error",
            message: err instanceof Error ? err.message : "Failed",
          });
        }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      });
    } finally {
      setRunning(false);
    }
  }, [date, league, minConfidence, source, setGameState]);

  const hasRun = states.size > 0;

  // Filter displayed plays
  const displayed = valuePlays.filter(
    (p) =>
      (marketFilter === "All" || p.market === marketFilter) &&
      p.analysis.confidence >= minConfidence
  );

  const percentDone = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="min-h-screen" style={{ background: "#111318" }}>
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-16">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-4xl font-bold text-white">Value Plays</h1>
            <p className="text-sm text-gray-500 mt-1">
              Claude AI scans all games and surfaces markets with genuine edge
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
                >
                  ‹
                </button>
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
                >
                  ›
                </button>
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
                      league === l
                        ? "bg-blue-600 text-white"
                        : "bg-[#252a3a] text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {l}
                  </button>
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
                      marketFilter === m
                        ? "bg-blue-600 text-white"
                        : "bg-[#252a3a] text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {m}
                  </button>
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
                      minConfidence === c
                        ? "bg-blue-600 text-white"
                        : "bg-[#252a3a] text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {c}+
                  </button>
                ))}
              </div>
            </div>

            {/* Run button */}
            <div className="ml-auto">
              <button
                onClick={running ? () => { abortRef.current = true; } : runAnalysis}
                className={`flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  running
                    ? "bg-red-900/40 text-red-400 border border-red-800/40 hover:bg-red-900/60"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
                }`}
              >
                {running ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Stop ({percentDone}%)
                  </>
                ) : hasRun ? (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Re-run
                  </>
                ) : (
                  <>
                    <TrendingUp className="w-4 h-4" />
                    Find Value Plays
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Progress bar */}
        {running && progress.total > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
              <span>Analyzing {progress.total} games with Claude AI...</span>
              <span>{progress.done}/{progress.total}</span>
            </div>
            <div className="h-1 bg-[#1a1d24] rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-300"
                style={{ width: `${percentDone}%` }}
              />
            </div>
          </div>
        )}

        {/* Game analysis status grid */}
        {hasRun && states.size > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-6">
            {[...states.entries()].map(([id, state]) => (
              <div
                key={id}
                title={state.status === "error" ? state.message : state.status}
                className={`w-3 h-3 rounded-sm ${
                  state.status === "loading"
                    ? "bg-gray-600 animate-pulse"
                    : state.status === "done"
                    ? "bg-green-600"
                    : "bg-red-700"
                }`}
              />
            ))}
            <span className="text-xs text-gray-600 ml-1 self-center">
              {[...states.values()].filter((s) => s.status === "done").length} analyzed ·{" "}
              {[...states.values()].filter((s) => s.status === "error").length} failed
            </span>
          </div>
        )}

        {/* Results */}
        {!hasRun && !running && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <TrendingUp className="w-12 h-12 text-gray-700 mb-4" />
            <p className="text-lg font-medium">Ready to scan for value</p>
            <p className="text-sm mt-1 text-center max-w-sm">
              Claude will analyze every game and surface markets where the Polymarket price doesn&apos;t
              reflect the true probability.
            </p>
            <button
              onClick={runAnalysis}
              className="mt-6 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-colors"
            >
              Find Value Plays
            </button>
          </div>
        )}

        {hasRun && displayed.length === 0 && !running && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <p className="text-lg font-medium">No value plays found</p>
            <p className="text-sm mt-1">
              {valuePlays.length > 0
                ? `${valuePlays.length} play(s) found but filtered out by current settings`
                : "Claude didn't identify clear edges in today's markets"}
            </p>
            {valuePlays.length > 0 && (
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
              {running && (
                <span className="text-xs text-blue-400 animate-pulse">Scanning more games...</span>
              )}
            </div>
            <div className="flex flex-col gap-3">
              {displayed.map((play, i) => (
                <ValuePlayCard key={`${play.gameId}-${play.market}-${i}`} play={play} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
