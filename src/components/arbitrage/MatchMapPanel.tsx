"use client";

import type { MatchMapData, MatchRejectReason } from "@/types/arbitrage";
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
};

function venuePill(v: string) {
  const s = VENUE_STYLE[v] ?? { color: "#6b7280", text: "#d1d5db" };
  const label = v === "sxbet" ? "SX.bet" : v.charAt(0).toUpperCase() + v.slice(1);
  return (
    <Pill key={v} color={s.color} text={s.text}>
      {label}
    </Pill>
  );
}

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

  return (
    <FloatingPanel title="Match Map" onClose={onClose} width="max-w-3xl">
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
          {live ? "LIVE MATCHING" : "MOCK DATA"}
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
                {pair.split("+").map((p) => (p === "sxbet" ? "SX.bet" : p[0].toUpperCase() + p.slice(1))).join(" + ")} {n}
              </Pill>
            ))}
          </span>
        </div>
      )}

      {/* Matched events */}
      <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Matched totals ({matched.length})</h3>
      <div className="space-y-2 mb-4">
        {matched.map((m) => (
          <div key={m.eventKey + m.line} className="rounded-lg border px-4 py-3" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
            <div className="flex items-center justify-between">
              <div className="font-semibold text-white">{m.matchup}</div>
              <span className="text-[10px] text-gray-500">{m.venues.length} venues · {(m.confidence * 100).toFixed(0)}% conf</span>
            </div>
            <div className="text-[10px] text-gray-500 mb-1">{m.sport} · {m.league.toUpperCase()}</div>
            <div className="flex items-center gap-2 text-[10px]">{m.venues.map(venuePill)}</div>
            <div className="text-[10px] text-gray-600 mt-1 uppercase tracking-wide">
              Cross-venue: TOTAL {m.line} · {m.legs.length} legs
            </div>
          </div>
        ))}
        {matched.length === 0 && (
          <p className="text-gray-500 text-center py-6 text-xs">
            No cross-venue totals matched{live ? " on the current slate — venues quote different lines." : " (mock)."}
          </p>
        )}
      </div>

      {/* Rejections */}
      {rejects.length > 0 && (
        <>
          <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Rejected ({rejects.length})</h3>
          <div className="space-y-1.5">
            {rejects.map((r, i) => (
              <div key={i} className="flex items-center gap-2 rounded border px-3 py-2 text-[11px]" style={{ borderColor: "#2a1e1e", background: "#150e0e" }}>
                <Pill color="#ef4444" text="#fca5a5">{REASON_LABEL[r.reason]}</Pill>
                <span className="text-white">{r.matchup}</span>
                <span className="text-gray-500 truncate">— {r.detail}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </FloatingPanel>
  );
}

function venuePillCount(v: string, n: number) {
  const s = VENUE_STYLE[v] ?? { color: "#6b7280", text: "#d1d5db" };
  const label = v === "sxbet" ? "SX.bet" : v.charAt(0).toUpperCase() + v.slice(1);
  return (
    <Pill key={v} color={s.color} text={s.text}>
      {label} {n}
    </Pill>
  );
}
