"use client";

import { useState } from "react";
import type { ArbLog } from "@/types/arbitrage";
import { formatClock, formatEdgePct } from "./arbFormat";

type FeedFilter = "ALL" | "TRADES" | "SCORES" | "SYSTEM";

// A live score-change event for a mapped game (built by the client from ESPN polling).
export type ScoreEvent = { id: string; time: string; text: string };

type FeedItem = {
  id: string;
  time: string;
  kind: Exclude<FeedFilter, "ALL">;
  text: string;
  edge?: number;
  result?: ArbLog["result"];
};

function buildFeed(logs: ArbLog[], scores: ScoreEvent[]): FeedItem[] {
  const tradeItems: FeedItem[] = logs.map((l) => ({
    id: l.id,
    time: l.time,
    kind: "TRADES",
    text: `${l.pair} — ${l.reason}`,
    edge: l.edge,
    result: l.result,
  }));
  const scoreItems: FeedItem[] = scores.map((s) => ({ id: s.id, time: s.time, kind: "SCORES", text: s.text }));
  return [...tradeItems, ...scoreItems].sort((a, b) => b.time.localeCompare(a.time));
}

export default function ActivityFeed({
  logs,
  scores = [],
  compact = false,
}: {
  logs: ArbLog[];
  scores?: ScoreEvent[];
  compact?: boolean;
}) {
  const [filter, setFilter] = useState<FeedFilter>("ALL");
  const feed = buildFeed(logs, scores);
  const shown = filter === "ALL" ? feed : feed.filter((f) => f.kind === filter);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "#1e2130" }}>
        <span className="font-semibold text-purple-300">Activity ({feed.length})</span>
        <div className="flex items-center gap-1 ml-auto">
          {(["ALL", "TRADES", "SCORES", "SYSTEM"] as FeedFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                filter === f ? "bg-blue-600 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {f}
              {f === "SCORES" && scores.length > 0 && <span className="ml-1 text-yellow-300">{scores.length}</span>}
            </button>
          ))}
        </div>
      </div>
      <p className="px-3 py-1 text-[10px] italic text-gray-600">Edge figures are net after fees · scores update live from ESPN.</p>
      <div className={`overflow-y-auto flex-1 ${compact ? "max-h-52" : ""}`}>
        {shown.length === 0 && <p className="px-3 py-4 text-[11px] text-gray-600 text-center">No activity yet.</p>}
        {shown.map((item) => (
          <div key={item.id} className="px-3 py-1.5 border-b border-[#15171e] leading-tight">
            <span className="text-gray-600 mr-2">{formatClock(item.time)}</span>
            <span
              className={
                item.kind === "SCORES"
                  ? "text-yellow-300 font-semibold"
                  : item.kind === "SYSTEM"
                    ? "text-amber-400"
                    : item.result === "executed"
                      ? "text-green-400"
                      : item.result === "naked"
                        ? "text-red-400"
                        : "text-gray-300"
              }
            >
              {item.text}
            </span>
            {item.edge != null && (
              <span className="ml-1 text-emerald-400 font-semibold">| {formatEdgePct(item.edge)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
