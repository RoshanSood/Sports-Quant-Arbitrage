"use client";

// Compact filter/sort toolbar above the grid (manual §7). Controls follow the app
// idiom but must not reduce grid density. Defaults per manual §29: anchor PrizePicks,
// side Over+Under, min line gap 0.5, min confidence 0.65.

import { useState } from "react";
import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import type { BookSummary, CanonicalStat, PropsFilters, ProviderHealth } from "@/types/props";
import { gameDateLabel } from "@/lib/props/format";
import { COLORS } from "./gridConfig";

type Props = {
  filters: PropsFilters;
  onChange: (patch: Partial<PropsFilters>) => void;
  comparisonBooks: BookSummary[];
  stats: CanonicalStat[];
  availableDates: { key: string; count: number }[];
  resultCount: number;
  totalCount: number;
  health: ProviderHealth[];
};

const inputStyle: React.CSSProperties = {
  background: "#04222a",
  border: `1px solid ${COLORS.divider}`,
  color: COLORS.ink,
};

function DateChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold"
      style={{
        background: active ? "#0b3a46" : "transparent",
        color: active ? COLORS.ink : COLORS.inkMuted,
        border: `1px solid ${active ? "#155e6b" : COLORS.divider}`,
      }}
    >
      {label}
      {count != null ? (
        <span className="text-[10px]" style={{ color: active ? "#7dd3fc" : COLORS.inkFaint }}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: COLORS.inkFaint }}>
        {label}
      </span>
      {children}
    </label>
  );
}

export default function PropsToolbar({
  filters,
  onChange,
  comparisonBooks,
  stats,
  availableDates,
  resultCount,
  totalCount,
  health,
}: Props) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  const provider = health[0];
  const statusColor =
    provider?.status === "healthy"
      ? "#22c55e"
      : provider?.status === "degraded"
        ? "#f59e0b"
        : provider?.status === "stale"
          ? "#f59e0b"
          : "#ef4444";

  function toggleBook(bookId: string) {
    const set = new Set(filters.visibleBookIds);
    if (set.has(bookId)) set.delete(bookId);
    else set.add(bookId);
    onChange({ visibleBookIds: [...set] });
  }

  return (
    <div
      className="mb-3 rounded-lg border p-3"
      style={{ background: "#031b21", borderColor: COLORS.divider }}
    >
      {/* Game-date filter — chips for dates that have games, plus a free date pick. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 border-b pb-3" style={{ borderColor: COLORS.divider }}>
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: COLORS.inkFaint }}>
          Game date
        </span>
        <DateChip active={filters.gameDate === "ALL"} label="All dates" onClick={() => onChange({ gameDate: "ALL" })} />
        {availableDates.map((d) => (
          <DateChip
            key={d.key}
            active={filters.gameDate === d.key}
            label={gameDateLabel(d.key)}
            count={d.count}
            onClick={() => onChange({ gameDate: d.key })}
          />
        ))}
        <input
          type="date"
          value={filters.gameDate === "ALL" ? "" : filters.gameDate}
          onChange={(e) => onChange({ gameDate: e.target.value || "ALL" })}
          className="ml-1 h-7 rounded px-2 text-[12px]"
          style={inputStyle}
          aria-label="Pick a game date"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Stat">
          <select
            value={filters.statId}
            onChange={(e) => onChange({ statId: e.target.value })}
            className="h-8 rounded px-2 text-[13px]"
            style={inputStyle}
          >
            <option value="ALL">All stats</option>
            {stats.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Max hold %">
          <input
            type="number"
            step={0.5}
            min={0}
            placeholder="off"
            value={filters.maxHoldPct == null ? "" : filters.maxHoldPct}
            onChange={(e) => onChange({ maxHoldPct: e.target.value === "" ? null : Number(e.target.value) })}
            className="h-8 w-20 rounded px-2 text-[13px]"
            style={inputStyle}
          />
        </Field>

        <Field label="Arbs only">
          <button
            onClick={() => onChange({ arbOnly: !filters.arbOnly })}
            className="flex h-8 items-center gap-2 rounded px-3 text-[12px] font-semibold"
            style={{
              ...inputStyle,
              background: filters.arbOnly ? "#0b3a46" : (inputStyle.background as string),
              color: filters.arbOnly ? COLORS.ink : COLORS.inkMuted,
            }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: filters.arbOnly ? COLORS.pill : COLORS.inkFaint }}
            />
            {filters.arbOnly ? "On" : "Off"}
          </button>
        </Field>

        <Field label="Search">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: COLORS.inkFaint }} />
            <input
              value={filters.search}
              onChange={(e) => onChange({ search: e.target.value })}
              placeholder="Player, team, stat"
              className="h-8 w-48 rounded pl-7 pr-2 text-[13px]"
              style={inputStyle}
            />
          </div>
        </Field>

        <div className="relative">
          <Field label="Columns">
            <button
              onClick={() => setColumnsOpen((o) => !o)}
              className="flex h-8 items-center gap-1.5 rounded px-3 text-[13px]"
              style={inputStyle}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {filters.visibleBookIds.filter((id) => comparisonBooks.some((b) => b.bookId === id)).length} books
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </Field>
          {columnsOpen ? (
            <div
              className="absolute right-0 z-50 mt-1 max-h-72 w-52 overflow-auto rounded-lg border p-2 shadow-xl"
              style={{ background: "#04222a", borderColor: COLORS.divider }}
            >
              {comparisonBooks.map((b) => (
                <label key={b.bookId} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={filters.visibleBookIds.includes(b.bookId)}
                    onChange={() => toggleBook(b.bookId)}
                  />
                  <span className="text-[12px]" style={{ color: COLORS.ink }}>
                    {b.name}
                  </span>
                  <span className="ml-auto text-[10px] uppercase" style={{ color: COLORS.inkFaint }}>
                    {b.category}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-4 text-[11px]" style={{ color: COLORS.inkMuted }}>
        <span>
          <strong style={{ color: COLORS.ink }}>{resultCount}</strong> / {totalCount} discrepancies
        </span>
        {provider ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: statusColor }} />
            {provider.providerId} · {provider.status}
            {provider.latencyMs != null ? ` · ${provider.latencyMs}ms` : ""}
          </span>
        ) : null}
        <span style={{ color: COLORS.inkFaint }}>Read-only · line gaps &amp; market edges, not guaranteed arbitrage</span>
      </div>
    </div>
  );
}
