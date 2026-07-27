"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MatchedEvent, MatchMapData, MatchReject, MatchRejectReason, VenueId } from "@/types/arbitrage";
import { FloatingPanel, Pill } from "./ui";

const REASON_LABEL: Record<MatchRejectReason, string> = {
  match_confidence_low: "confidence low",
  line_mismatch: "line mismatch",
  same_outcome: "same outcome",
  self_edge: "self edge",
  start_time_window: "time window",
  identity_dedup: "identity dedup",
};

const VENUE_STYLE: Record<string, { color: string; text: string }> = {
  kalshi: { color: "#3b82f6", text: "#93c5fd" },
  polymarket: { color: "#8b5cf6", text: "#c4b5fd" },
  sxbet: { color: "#a855f7", text: "#d8b4fe" },
  predictfun: { color: "#f472b6", text: "#fbcfe8" },
  cloudbet: { color: "#16a34a", text: "#86efac" },
};

type GameGroup = {
  eventKey: string;
  matchup: string;
  sport: string;
  league: string;
  venues: VenueId[];
  confidence: number;
  markets: MatchedEvent[];
  rejects: MatchReject[];
};

export default function MatchMapPanel({
  data,
  live,
  onClose,
}: {
  data: MatchMapData | null;
  live: boolean;
  onClose: () => void;
}) {
  const stats = data?.stats;
  const matched = data?.matched ?? [];
  const rejects = data?.rejects ?? [];
  const [openGames, setOpenGames] = useState<Record<string, boolean>>({});

  const grouped = useMemo(() => groupByGame(matched, rejects), [matched, rejects]);
  const matchedMarketCount = grouped.reduce((sum, g) => sum + g.markets.length, 0);

  return (
    <FloatingPanel title="Match Map" onClose={onClose} width="max-w-5xl">
      <div className="flex items-center gap-2 mb-3">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
          style={{
            background: live ? "#0d1a0f" : "#1a160e",
            color: live ? "#4ade80" : "#fbbf24",
            border: `1px solid ${live ? "#14532d" : "#3f2d10"}`,
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: live ? "#22c55e" : "#f59e0b" }} />
          {live ? "LIVE MATCHING" : "SCANNING..."}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-3 text-[11px]">
        <Pill>matched {stats?.matched ?? 0}</Pill>
        {Object.entries(stats?.byVenue ?? {}).map(([v, n]) => venuePillCount(v, n))}
        <Pill color="#6b7280">dedup dropped {stats?.dedupDropped ?? 0}</Pill>
        <Pill color="#6b7280">self edge dropped {stats?.selfEdgeDropped ?? 0}</Pill>
        <Pill color="#f97316" text="#fdba74">line mismatch {stats?.lineMismatch ?? 0}</Pill>
        <Pill color="#f97316" text="#fdba74">invariant rejected {stats?.invariantRejected ?? 0}</Pill>
      </div>

      {Object.keys(stats?.byVenuePair ?? {}).length > 0 && (
        <div className="mb-3 text-[11px] text-gray-500">
          <span className="uppercase tracking-wide mr-2">By venue pair</span>
          <span className="inline-flex gap-2 flex-wrap">
            {Object.entries(stats!.byVenuePair).map(([pair, n]) => (
              <Pill key={pair} color="#22c55e" text="#86efac">
                {pair.split("+").map(venueLabel).join(" + ")} {n}
              </Pill>
            ))}
          </span>
        </div>
      )}

      <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">
        Matched games ({grouped.length}) - markets ({matchedMarketCount})
      </h3>
      <div className="space-y-2 mb-4">
        {grouped.map((g, index) => {
          const isOpen = openGames[g.eventKey] ?? index < 2;
          return (
            <div key={g.eventKey} className="rounded-lg border" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
              <button
                onClick={() => setOpenGames((prev) => ({ ...prev, [g.eventKey]: !isOpen }))}
                className="w-full px-4 py-3 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />}
                      <div className="font-semibold text-white truncate">{g.matchup}</div>
                    </div>
                    <div className="text-[10px] text-gray-500 ml-6">
                      {g.sport} - {g.league.toUpperCase()} - {marketCountLabel(g.markets)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-gray-500">{g.venues.length} venues - {(g.confidence * 100).toFixed(0)}% conf</div>
                    <div className="flex justify-end gap-1 mt-1 flex-wrap max-w-sm">{g.venues.map(venuePill)}</div>
                  </div>
                </div>
              </button>

              {isOpen && (
                <div className="border-t px-4 py-3" style={{ borderColor: "#1e2130" }}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b" style={{ borderColor: "#1e2130" }}>
                          <th className="py-2 pr-3">Market</th>
                          <th className="py-2 pr-3">Venues</th>
                          <th className="py-2 pr-3">Tracked Lines</th>
                          <th className="py-2 pr-3 text-right">Legs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortMarkets(g.markets).map((m) => (
                          <tr key={`${m.eventKey}:${m.marketType}:${m.line}`} className="border-b last:border-0" style={{ borderColor: "#15171e" }}>
                            <td className="py-2 pr-3 text-white font-semibold whitespace-nowrap">{marketLabel(m)}</td>
                            <td className="py-2 pr-3">
                              <div className="flex gap-1 flex-wrap">{m.venues.map(venuePill)}</div>
                            </td>
                            <td className="py-2 pr-3 text-gray-300">
                              <div className="flex flex-wrap gap-1.5">{venueLegs(m)}</div>
                            </td>
                            <td className="py-2 pr-3 text-right text-gray-500 whitespace-nowrap">{m.legs.length} legs</td>
                          </tr>
                        ))}
                        {g.rejects.map((r, i) => (
                          <tr key={`reject:${i}:${r.detail}`} className="border-b last:border-0" style={{ borderColor: "#15171e" }}>
                            <td className="py-2 pr-3"><Pill color="#ef4444" text="#fca5a5">{REASON_LABEL[r.reason]}</Pill></td>
                            <td className="py-2 pr-3 text-gray-500">{r.marketType}</td>
                            <td className="py-2 pr-3 text-gray-500" colSpan={2}>{r.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {grouped.length === 0 && (
          <p className="text-gray-500 text-center py-6 text-xs">
            No cross-venue markets matched{live ? " on the current slate. Venues may quote different lines." : " (mock)."}
          </p>
        )}
      </div>

      {rejects.length > 0 && (
        <>
          <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Rejected ({rejects.length})</h3>
          <div className="space-y-1.5">
            {rejects.slice(0, 20).map((r, i) => (
              <div key={i} className="flex items-center gap-2 rounded border px-3 py-2 text-[11px]" style={{ borderColor: "#2a1e1e", background: "#150e0e" }}>
                <Pill color="#ef4444" text="#fca5a5">{REASON_LABEL[r.reason]}</Pill>
                <span className="text-white">{r.matchup}</span>
                <span className="text-gray-500 truncate">- {r.detail}</span>
              </div>
            ))}
            {rejects.length > 20 && <div className="text-[10px] text-gray-600 px-1">Showing 20 of {rejects.length} rejected mappings.</div>}
          </div>
        </>
      )}
    </FloatingPanel>
  );
}

function groupByGame(matched: MatchedEvent[], rejects: MatchReject[]): GameGroup[] {
  const map = new Map<string, GameGroup>();
  for (const m of matched) {
    const group = map.get(m.eventKey) ?? {
      eventKey: m.eventKey,
      matchup: m.matchup,
      sport: m.sport,
      league: m.league,
      venues: [],
      confidence: 0,
      markets: [],
      rejects: [],
    };
    group.markets.push(m);
    group.confidence = Math.max(group.confidence, m.confidence);
    group.venues = [...new Set([...group.venues, ...m.venues])];
    map.set(m.eventKey, group);
  }

  for (const r of rejects) {
    const group = map.get(r.eventKey) ?? {
      eventKey: r.eventKey,
      matchup: r.matchup,
      sport: "baseball",
      league: "mlb",
      venues: [],
      confidence: 0,
      markets: [],
      rejects: [],
    };
    group.rejects.push(r);
    map.set(r.eventKey, group);
  }

  return [...map.values()].sort((a, b) => a.matchup.localeCompare(b.matchup));
}

function marketRank(m: MatchedEvent): number {
  if (m.marketType === "moneyline") return 0;
  if (m.marketType === "spread") return 1;
  return 2;
}

function sortMarkets(markets: MatchedEvent[]): MatchedEvent[] {
  return [...markets].sort((a, b) => marketRank(a) - marketRank(b) || (a.line ?? 0) - (b.line ?? 0));
}

function marketLabel(m: MatchedEvent): string {
  if (m.marketType === "moneyline") return "Moneyline";
  if (m.marketType === "spread") return `Run line ${m.line > 0 ? "+" : ""}${m.line}`;
  return `Game total ${m.line}`;
}

function marketCountLabel(markets: MatchedEvent[]): string {
  const totals = markets.filter((m) => m.marketType === "total").length;
  const moneyline = markets.some((m) => m.marketType === "moneyline");
  const spreads = markets.filter((m) => m.marketType === "spread").length;
  const parts = [];
  if (totals) parts.push(`${totals} totals`);
  if (moneyline) parts.push("moneyline");
  if (spreads) parts.push(`${spreads} run line${spreads === 1 ? "" : "s"}`);
  return parts.join(" - ") || "no matched markets";
}

function venueLegs(m: MatchedEvent): ReactNode[] {
  return m.legs.map((leg) => (
    <span
      key={`${leg.venueId}:${leg.outcome}:${leg.line}:${leg.priceCents}`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
      style={{ background: "#12151d", color: "#d1d5db", border: "1px solid #1e2130" }}
    >
      <span className="font-semibold" style={{ color: VENUE_STYLE[leg.venueId]?.text ?? "#d1d5db" }}>
        {venueLabel(leg.venueId)}
      </span>
      <span>{leg.label}</span>
      <span className="text-gray-500">{leg.priceCents}c</span>
    </span>
  ));
}

function venueLabel(v: string): string {
  if (v === "sxbet") return "SX.bet";
  if (v === "predictfun") return "Predict.fun";
  if (v === "cloudbet") return "Cloudbet";
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function venuePill(v: string) {
  const s = VENUE_STYLE[v] ?? { color: "#6b7280", text: "#d1d5db" };
  return (
    <Pill key={v} color={s.color} text={s.text}>
      {venueLabel(v)}
    </Pill>
  );
}

function venuePillCount(v: string, n: number) {
  const s = VENUE_STYLE[v] ?? { color: "#6b7280", text: "#d1d5db" };
  return (
    <Pill key={v} color={s.color} text={s.text}>
      {venueLabel(v)} {n}
    </Pill>
  );
}
