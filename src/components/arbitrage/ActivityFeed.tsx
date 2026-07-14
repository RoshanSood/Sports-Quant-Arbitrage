"use client";

import { useState } from "react";
import type { ArbLog } from "@/types/arbitrage";
import { formatClock, formatEdgePct } from "./arbFormat";

type FeedFilter = "ALL" | "TRADES" | "MARKETS" | "SYSTEM";

// Derive a lightweight activity stream from arb logs + a few synthetic market lines,
// mirroring the screenshot's "Cross-venue edge:" ticker.
type FeedItem = {
  id: string;
  time: string;
  kind: FeedFilter;
  text: string;
  edge?: number;
  result?: ArbLog["result"];
};

function buildFeed(logs: ArbLog[]): FeedItem[] {
  const items: FeedItem[] = logs.map((l) => ({
    id: l.id,
    time: l.time,
    kind: "TRADES" as const,
    text: `${l.pair} — ${l.reason}`,
    edge: l.edge,
    result: l.result,
  }));

  const markets: FeedItem[] = [
    { id: "m1", time: "2026-07-07T23:52:59.000Z", kind: "MARKETS", text: "Cross-venue edge: Philadelphia vs Cincinnati | O/U 6.5 | buy_yes_a_no_b", edge: 0.0836 },
    { id: "m2", time: "2026-07-07T23:50:23.000Z", kind: "MARKETS", text: "Cross-venue edge: Houston vs Washington | O/U 10.5 | buy_yes_a_no_b", edge: 0.0665 },
    { id: "m3", time: "2026-07-07T23:50:23.000Z", kind: "MARKETS", text: "Cross-venue edge: Seattle vs Miami | O/U 6.5 | buy_no_a_yes_b", edge: 0.0231 },
    { id: "s1", time: "2026-07-07T23:53:12.000Z", kind: "SYSTEM", text: "Arena running" },
    { id: "s2", time: "2026-07-07T23:42:42.000Z", kind: "SYSTEM", text: "Arena stopped" },
  ];

  return [...items, ...markets].sort((a, b) => b.time.localeCompare(a.time));
}

export default function ActivityFeed({ logs, compact = false }: { logs: ArbLog[]; compact?: boolean }) {
  const [filter, setFilter] = useState<FeedFilter>("ALL");
  const feed = buildFeed(logs);
  const shown = filter === "ALL" ? feed : feed.filter((f) => f.kind === filter);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "#1e2130" }}>
        <span className="font-semibold text-purple-300">Activity ({feed.length})</span>
        <div className="flex items-center gap-1 ml-auto">
          {(["ALL", "TRADES", "MARKETS", "SYSTEM"] as FeedFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                filter === f ? "bg-blue-600 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <p className="px-3 py-1 text-[10px] italic text-gray-600">Edge figures shown are net after fees.</p>
      <div className={`overflow-y-auto flex-1 ${compact ? "max-h-52" : ""}`}>
        {shown.map((item) => (
          <div key={item.id} className="px-3 py-1.5 border-b border-[#15171e] leading-tight">
            <span className="text-gray-600 mr-2">{formatClock(item.time)}</span>
            <span
              className={
                item.kind === "SYSTEM"
                  ? "text-amber-400"
                  : item.result === "executed"
                  ? "text-green-400"
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
