"use client";

// Player Props — client root (manual §9). Fetches the materialized true-arb rows
// from /api/props/bootstrap, polls /api/props/rows while an ingestion runs, and
// falls back to bundled mock MLB data when the provider key isn't set. Each row is a
// single two-way market (over + under); filters/sort are odds/arb-oriented.
// V1 is READ-ONLY.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookSummary, DisplayQuote, ProviderHealth, PropsFilters, PropsGridRow } from "@/types/props";
import { BOOKS } from "@/lib/props/books";
import { DEFAULT_FILTERS, todayDateStr } from "@/lib/props/config";
import { gameDateKey } from "@/lib/props/format";
import { listStats } from "@/lib/props/statRegistry";
import { getMockBootstrap } from "@/lib/props/mockData";
import PropsToolbar from "./PropsToolbar";
import PropsGrid from "./PropsGrid";
import PropDetailDrawer from "./PropDetailDrawer";
import { COLORS, ROW_H } from "./gridConfig";

type Source = "loading" | "live" | "mock";

function passesFilters(row: PropsGridRow, f: PropsFilters): boolean {
  if (f.statId !== "ALL" && row.stat.id !== f.statId) return false;
  if (f.gameDate !== "ALL" && gameDateKey(row.event.startTime) !== f.gameDate) return false;
  if (f.arbOnly && !row.arb?.isArb) return false;
  if (f.maxHoldPct != null && (row.arb?.holdPct == null || row.arb.holdPct > f.maxHoldPct)) return false;
  if (f.search.trim()) {
    const q = f.search.trim().toLowerCase();
    const hay = `${row.player.name} ${row.player.team} ${row.event.matchupLabel} ${row.stat.label}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// Tightest two-way market first: arbs (highest edge), then lowest hold.
function arbEdge(r: PropsGridRow): number {
  return r.arb?.edgePct ?? -1e9;
}

export default function PropsClient() {
  const [source, setSource] = useState<Source>("loading");
  const [rows, setRows] = useState<PropsGridRow[]>([]);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [running, setRunning] = useState(false);
  const [filters, setFilters] = useState<PropsFilters>(DEFAULT_FILTERS);
  const [selection, setSelection] = useState<{ row: PropsGridRow; quote: DisplayQuote | null } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stats = useMemo(() => listStats(), []);
  const date = useMemo(() => todayDateStr(), []);

  const pollRows = useCallback(
    async function poll() {
      try {
        const res = await fetch(`/api/props/rows?date=${date}`, { cache: "no-store" });
        const data = await res.json();
        setRows(data.rows ?? []);
        setHealth(data.health ?? []);
        setRunning(Boolean(data.running));
        if (data.running) pollRef.current = setTimeout(poll, 4000);
      } catch {
        setRunning(false);
      }
    },
    [date]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/props/bootstrap?date=${date}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (data.providerConfigured) {
          setSource("live");
          setRows(data.rows ?? []);
          setHealth(data.health ?? []);
          setRunning(Boolean(data.running));
          if (data.running) pollRef.current = setTimeout(pollRows, 4000);
        } else {
          const mock = getMockBootstrap();
          setSource("mock");
          setRows(mock.rows);
          setHealth(mock.health);
        }
      } catch {
        if (cancelled) return;
        const mock = getMockBootstrap();
        setSource("mock");
        setRows(mock.rows);
        setHealth(mock.health);
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [date, pollRows]);

  // Distinct game dates present in the loaded rows (chips per date that has games).
  const availableDates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = gameDateKey(r.event.startTime);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
  }, [rows]);

  const allBooks: BookSummary[] = BOOKS;
  const visibleBooks = useMemo(() => BOOKS.filter((b) => filters.visibleBookIds.includes(b.bookId)), [filters.visibleBookIds]);

  const displayRows = useMemo(() => {
    return rows.filter((r) => passesFilters(r, filters)).sort((a, b) => {
      if (arbEdge(b) !== arbEdge(a)) return arbEdge(b) - arbEdge(a);
      return new Date(a.event.startTime).getTime() - new Date(b.event.startTime).getTime();
    });
  }, [rows, filters]);

  const arbCount = useMemo(() => displayRows.filter((r) => r.arb?.isArb).length, [displayRows]);
  const provider = health[0];
  const stale = provider && provider.status !== "healthy" && source === "live";

  function patchFilters(patch: Partial<PropsFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  return (
    <div className="min-h-screen" style={{ background: COLORS.page }}>
      <div className="mx-auto max-w-[1400px] px-4 py-5">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-[20px] font-bold" style={{ color: COLORS.ink }}>
              Player Props <span style={{ color: COLORS.inkFaint }}>· Cross-Book Arbitrage</span>
            </h1>
            <p className="text-[12px]" style={{ color: COLORS.inkMuted }}>
              MLB · best over + best under across sportsbooks. Green = the books to bet. Read-only.
            </p>
          </div>
          {source === "mock" ? (
            <span className="rounded-full px-3 py-1 text-[11px] font-semibold" style={{ background: "rgba(167,139,250,0.12)", color: "#c4b5fd" }}>
              Sample data · set SPORTSGAMEODDS_KEY for live
            </span>
          ) : running ? (
            <span className="rounded-full px-3 py-1 text-[11px] font-semibold" style={{ background: "rgba(56,189,248,0.12)", color: "#7dd3fc" }}>
              Scanning live markets…
            </span>
          ) : arbCount > 0 ? (
            <span className="rounded-full px-3 py-1 text-[11px] font-semibold" style={{ background: "rgba(34,197,94,0.14)", color: "#4ade80" }}>
              {arbCount} live arb{arbCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        {stale ? (
          <div
            className="mb-3 rounded-lg border px-3 py-2 text-[12px]"
            style={{ borderColor: "#f59e0b", background: "rgba(245,158,11,0.08)", color: "#fcd34d" }}
          >
            Provider {provider?.status}. Showing last snapshot; markets may be suspended (best legs flagged ⚠).
          </div>
        ) : null}

        <PropsToolbar
          filters={filters}
          onChange={patchFilters}
          comparisonBooks={allBooks}
          stats={stats}
          availableDates={availableDates}
          resultCount={displayRows.length}
          totalCount={rows.length}
          health={health}
        />

        {source === "loading" ? (
          <SkeletonGrid />
        ) : displayRows.length === 0 ? (
          <div className="rounded-lg border p-10 text-center text-[13px]" style={{ borderColor: COLORS.divider, color: COLORS.inkMuted }}>
            {running
              ? "Scanning sportsbooks for MLB player-prop odds…"
              : rows.length === 0
                ? "No MLB props available right now (no slate, or markets suspended between games). Try again closer to game time."
                : "No props match the current filters — turn off Arbs-only, raise Max hold %, or clear the date/stat filters."}
          </div>
        ) : (
          <PropsGrid rows={displayRows} comparisonBooks={visibleBooks} onSelect={setSelection} />
        )}
      </div>

      {selection ? (
        <PropDetailDrawer row={selection.row} focusedQuote={selection.quote} books={allBooks} onClose={() => setSelection(null)} />
      ) : null}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: COLORS.divider }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3" style={{ height: ROW_H, borderTop: i ? `1px solid ${COLORS.divider}` : undefined }}>
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full" style={{ background: "#0c2a32" }} />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-40 animate-pulse rounded" style={{ background: "#0c2a32" }} />
            <div className="h-2 w-24 animate-pulse rounded" style={{ background: "#0c2a32" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
