"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, KeyRound, X } from "lucide-react";
import type { ArbLog, ArbOpportunity, Trade, Venue } from "@/types/arbitrage";
import { venueStatusColor } from "./arbFormat";
import { CREDS_CHANGED_EVENT, hasVenueCreds } from "./venueCreds";
import ActivityFeed, { type ScoreEvent } from "./ActivityFeed";

// Fractional layout (0-1 of the canvas) for the default node positions. Users can
// drag nodes; only dragged positions are stored as overrides so no seeding effect
// is needed.
const DEFAULT_LAYOUT: Record<string, { fx: number; fy: number }> = {
  home: { fx: 0.5, fy: 0.62 },
  kalshi: { fx: 0.24, fy: 0.58 },
  polymarket: { fx: 0.38, fy: 0.28 },
  sxbet: { fx: 0.68, fy: 0.30 },
  predictfun: { fx: 0.78, fy: 0.58 },
  cloudbet: { fx: 0.18, fy: 0.34 },
  sportmarket: { fx: 0.5, fy: 0.16 },
};

type Pos = { fx: number; fy: number };

// A live edge between two books, e.g. kalshi <-> polymarket, with its net edge.
export type BookEdge = { a: string; b: string; netEdge: number };

// An in-progress/settled agent trade the arena animates: the agent slides to legA,
// draws an edge to legB, and shows a result marker.
export type AgentTrade = {
  legA: string;
  legB: string;
  status: "pending" | "success" | "fail";
};

export default function ArenaCanvas({
  venues,
  logs,
  opportunities = [],
  trades = [],
  scores = [],
  edges,
  agentName,
  agentTrade,
  marketsLive = false,
  scanning = false,
  onSelectVenue,
}: {
  venues: Venue[];
  logs: ArbLog[];
  opportunities?: ArbOpportunity[];
  trades?: Trade[];
  scores?: ScoreEvent[];
  edges: BookEdge[];
  agentName: string;
  agentTrade: AgentTrade | null;
  marketsLive?: boolean;
  scanning?: boolean;
  onSelectVenue: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 640 });
  const [overrides, setOverrides] = useState<Record<string, Pos>>({});
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);

  // Which venues have credentials entered in THIS browser (drives the key badge). Starts
  // empty (SSR-safe), then the effect computes it and re-checks whenever creds change.
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const refresh = () => setConnected(Object.fromEntries(venues.map((v) => [v.id, hasVenueCreds(v.id)])));
    window.addEventListener(CREDS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    window.dispatchEvent(new Event(CREDS_CHANGED_EVENT)); // initial compute via the handler
    return () => {
      window.removeEventListener(CREDS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [venues]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const posFor = useCallback(
    (id: string): Pos => overrides[id] ?? DEFAULT_LAYOUT[id] ?? { fx: 0.5, fy: 0.5 },
    [overrides]
  );
  const px = useCallback((p: Pos) => ({ x: p.fx * size.w, y: p.fy * size.h }), [size]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.nodeId;
    if (!id) return;
    dragRef.current = { id, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    const el = canvasRef.current;
    if (!drag || !el) return;
    const rect = el.getBoundingClientRect();
    const fx = clamp((e.clientX - rect.left) / rect.width, 0.05, 0.95);
    const fy = clamp((e.clientY - rect.top) / rect.height, 0.05, 0.95);
    drag.moved = true;
    setOverrides((prev) => ({ ...prev, [drag.id]: { fx, fy } }));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
      if (drag && !drag.moved && drag.id !== "home") onSelectVenue(drag.id);
    },
    [onSelectVenue]
  );

  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? id;
  const home = px(posFor("home"));

  // Agent chip: rests just left of HOME BASE; during a trade it slides above legA.
  const agentRest = { x: home.x - 18, y: home.y };
  const agentPos = agentTrade ? { x: px(posFor(agentTrade.legA)).x, y: px(posFor(agentTrade.legA)).y - 48 } : agentRest;
  const tradeColor = agentTrade?.status === "success" ? "#22c55e" : agentTrade?.status === "fail" ? "#ef4444" : "#22d3ee";

  return (
    <div className="relative w-full h-full overflow-hidden" style={{ background: "#0b0d12" }}>
      <div ref={canvasRef} className="absolute inset-0" onPointerMove={onPointerMove}>
        {/* Edge layer */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" width={size.w} height={size.h}>
          {/* Live book-to-book edges (one per active venue pair). */}
          {edges.map((e) => {
            const a = px(posFor(e.a));
            const b = px(posFor(e.b));
            const pathId = `edge-${e.a}-${e.b}`;
            const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
            return (
              <g key={pathId}>
                <path id={pathId} d={d} fill="none" stroke="#22c55e" strokeWidth={2} strokeDasharray="6 6" opacity={0.85} />
                <circle r={4} fill="#22c55e">
                  <animateMotion dur="2.2s" repeatCount="indefinite">
                    <mpath href={`#${pathId}`} />
                  </animateMotion>
                </circle>
              </g>
            );
          })}

          {/* Active trade route legA -> legB, emphasized and colored by result. */}
          {agentTrade && (() => {
            const a = px(posFor(agentTrade.legA));
            const b = px(posFor(agentTrade.legB));
            const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
            return (
              <g key="trade-edge">
                <path id="trade-edge-path" d={d} fill="none" stroke={tradeColor} strokeWidth={3} strokeDasharray="4 4" opacity={0.95} />
                <circle r={5} fill={tradeColor}>
                  <animateMotion dur="1.1s" repeatCount="indefinite">
                    <mpath href="#trade-edge-path" />
                  </animateMotion>
                </circle>
              </g>
            );
          })()}
        </svg>

        {/* Edge % labels (HTML, positioned at each edge midpoint). */}
        {edges.map((e) => {
          const a = px(posFor(e.a));
          const b = px(posFor(e.b));
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          return (
            <span
              key={`lbl-${e.a}-${e.b}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded text-[10px] font-bold pointer-events-none"
              style={{ left: mid.x, top: mid.y, background: "#0d1a0f", color: "#4ade80", border: "1px solid #14532d" }}
            >
              {(e.netEdge * 100).toFixed(1)}%
            </span>
          );
        })}

        {/* Home base label + value-bet chip */}
        <div className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none" style={{ left: home.x + 16, top: home.y }}>
          <span className="w-6 h-6 rounded-full grid place-items-center text-[9px] font-bold bg-blue-500 text-black">VB</span>
        </div>
        <span className="absolute -translate-x-1/2 text-[9px] tracking-widest text-gray-500 pointer-events-none" style={{ left: home.x, top: home.y + 22 }}>
          HOME BASE
        </span>

        {/* The kalshi-mlb agent chip — slides to legA during a trade, shows ✓/✗. */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none z-10"
          style={{ left: agentPos.x, top: agentPos.y, transition: "left 0.6s ease, top 0.6s ease" }}
        >
          <div className="relative">
            <span
              className="w-7 h-7 rounded-full grid place-items-center text-[9px] font-bold bg-teal-500 text-black"
              style={{ boxShadow: agentTrade ? `0 0 12px ${tradeColor}` : "none" }}
            >
              KAL
            </span>
            {agentTrade?.status === "success" && (
              <span className="absolute -inset-1 grid place-items-center rounded-full" style={{ background: "#052e16cc" }}>
                <Check className="w-5 h-5" strokeWidth={3} style={{ color: "#22c55e" }} />
              </span>
            )}
            {agentTrade?.status === "fail" && (
              <span className="absolute -inset-1 grid place-items-center rounded-full" style={{ background: "#450a0acc" }}>
                <X className="w-5 h-5" strokeWidth={3} style={{ color: "#ef4444" }} />
              </span>
            )}
          </div>
          <span className="mt-1 text-[9px] whitespace-nowrap" style={{ color: agentTrade ? tradeColor : "#9ca3af" }}>
            {agentTrade ? `${venueName(agentTrade.legA)} → ${venueName(agentTrade.legB)}` : agentName}
          </span>
        </div>

        {/* Home base node (draggable anchor, invisible hit area) */}
        <div
          data-node-id="home"
          className="absolute -translate-x-1/2 -translate-y-1/2 w-16 h-10 cursor-grab active:cursor-grabbing touch-none"
          style={{ left: home.x, top: home.y }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />

        {/* Venue nodes */}
        {venues.map((v) => {
          const a = px(posFor(v.id));
          return (
            <div
              key={v.id}
              data-node-id={v.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing select-none touch-none"
              style={{ left: a.x, top: a.y }}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
            >
              <div
                className="relative rounded-xl border-2 px-5 py-3 min-w-[110px] text-center transition-shadow hover:shadow-lg"
                style={{
                  background: "#12151d",
                  borderColor: v.enabled ? v.color ?? "#3b82f6" : "#2a2d35",
                  opacity: v.enabled ? 1 : 0.55,
                  boxShadow: v.enabled ? `0 0 18px ${v.color ?? "#3b82f6"}22` : "none",
                }}
              >
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full" style={{ background: venueStatusColor(v.status) }} />
                {/* Credential badge: green key when this browser has creds for the venue. */}
                <span
                  className="absolute top-1.5 left-2 grid place-items-center"
                  title={connected[v.id] ? "Credentials entered" : "No credentials — open to add"}
                >
                  <KeyRound className="w-3 h-3" style={{ color: connected[v.id] ? "#22c55e" : "#3a3f4b" }} />
                </span>
                <div className="text-lg font-bold" style={{ color: v.color ?? "#e5e7eb" }}>{v.abbr}</div>
                <div className="text-[11px] text-gray-400">{v.name}</div>
                {v.activeEdges ? (
                  <span className="absolute -bottom-2 -right-2 w-5 h-5 rounded-full grid place-items-center text-[9px] font-bold bg-green-600 text-white">
                    {v.activeEdges}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Docked activity feed */}
      <div className="absolute bottom-3 left-3 w-80 rounded-lg border shadow-xl" style={{ background: "#0e1014", borderColor: "#1e2130" }}>
        <ActivityFeed logs={logs} opportunities={opportunities} trades={trades} scores={scores} compact />
      </div>

      <div className="absolute top-3 right-4 flex items-center gap-2 text-[10px] text-gray-600">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold"
          style={{
            background: marketsLive ? "#0d1a0f" : scanning ? "#1a160e" : "#11141a",
            color: marketsLive ? "#4ade80" : scanning ? "#fbbf24" : "#9ca3af",
            border: `1px solid ${marketsLive ? "#14532d" : scanning ? "#3f2d10" : "#2a2f3e"}`,
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: marketsLive ? "#22c55e" : scanning ? "#f59e0b" : "#6b7280" }} />
          {marketsLive ? "LIVE MARKETS" : scanning ? "SCANNING..." : "IDLE"}
        </span>
        <span>Drag nodes · click for details</span>
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
