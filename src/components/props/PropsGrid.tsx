"use client";

// The true-arb grid (manual §5–§6). One row per prop: sticky Player / Stat / Line on
// the left; then BET OVER + BET UNDER (the exact two books to bet, highlighted), the
// 2-way edge, and every book's over/under prices. The best-over and best-under books
// are tinted green — those are the legs of the arb.

import { useState } from "react";
import { User } from "lucide-react";
import type { BookSummary, DisplayQuote, PropsGridRow, TwoWayCell } from "@/types/props";
import { getBook } from "@/lib/props/books";
import { formatAmerican, formatLine, formatStartTime } from "@/lib/props/format";
import { COLORS, HEADER_H, ROW_H, W } from "./gridConfig";

type Selection = { row: PropsGridRow; quote: DisplayQuote | null };

type Props = {
  rows: PropsGridRow[];
  comparisonBooks: BookSummary[];
  onSelect: (sel: Selection) => void;
};

const CATEGORY_DOT: Record<BookSummary["category"], string> = {
  dfs: "#a78bfa",
  sharp: "#38bdf8",
  sportsbook: "#7fa6ab",
};

function HeadCell({ w, label, align = "center" }: { w: number; label: string; align?: "left" | "center" }) {
  return (
    <div
      className="flex items-center px-2 text-[11px] font-semibold uppercase tracking-wide"
      style={{ width: w, minWidth: w, height: HEADER_H, color: COLORS.inkMuted, justifyContent: align === "left" ? "flex-start" : "center" }}
    >
      {label}
    </div>
  );
}

export default function PropsGrid({ rows, comparisonBooks, onSelect }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div
      className="overflow-auto rounded-lg border"
      style={{ maxHeight: "calc(100vh - 220px)", borderColor: COLORS.divider, background: COLORS.page }}
    >
      <div style={{ width: "max-content", minWidth: "100%" }}>
        {/* Header */}
        <div className="flex" style={{ height: HEADER_H, position: "sticky", top: 0, zIndex: 30 }}>
          <div className="flex" style={{ position: "sticky", left: 0, zIndex: 40, background: COLORS.header }}>
            <HeadCell w={W.player} label="Player Name" align="left" />
            <HeadCell w={W.stat} label="Stat" />
            <HeadCell w={W.line} label="Line" />
          </div>
          <div className="flex" style={{ background: COLORS.header }}>
            <HeadCell w={W.betOver} label="Bet Over" />
            <HeadCell w={W.betUnder} label="Bet Under" />
            <HeadCell w={W.edge} label="2-Way Edge" />
            {comparisonBooks.map((b) => (
              <div
                key={b.bookId}
                className="flex flex-col items-center justify-center gap-0.5"
                style={{ width: W.book, minWidth: W.book, height: HEADER_H }}
                title={b.name}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: CATEGORY_DOT[b.category] }} />
                <span className="text-[11px] font-bold" style={{ color: COLORS.ink }}>
                  {b.abbreviation}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Rows */}
        {rows.map((row) => {
          const rowBg = hovered === row.rowId ? COLORS.rowAlt : COLORS.row;
          return (
            <div
              key={row.rowId}
              className="flex"
              style={{ height: ROW_H, borderTop: `1px solid ${COLORS.divider}` }}
              onMouseEnter={() => setHovered(row.rowId)}
              onMouseLeave={() => setHovered(null)}
            >
              <div className="flex" style={{ position: "sticky", left: 0, zIndex: 20, background: rowBg }}>
                <PlayerCell row={row} onClick={() => onSelect({ row, quote: null })} />
                <StatCell row={row} />
                <LineCell row={row} onClick={() => onSelect({ row, quote: null })} />
              </div>
              <div className="flex" style={{ background: rowBg }}>
                <BetCell row={row} side="OVER" onClick={() => onSelect({ row, quote: null })} />
                <BetCell row={row} side="UNDER" onClick={() => onSelect({ row, quote: null })} />
                <EdgeCell row={row} onClick={() => onSelect({ row, quote: null })} />
                {comparisonBooks.map((b) => (
                  <TwoWayBookCell
                    key={b.bookId}
                    cell={row.twoWayCells[b.bookId] ?? { over: null, under: null }}
                    onSelect={(quote) => onSelect({ row, quote })}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlayerCell({ row, onClick }: { row: PropsGridRow; onClick: () => void }) {
  const { player, event } = row;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 px-3 text-left hover:opacity-90"
      style={{ width: W.player, minWidth: W.player, height: ROW_H }}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full"
        style={{ background: "#0c2a32", border: `1px solid ${COLORS.divider}` }}
      >
        <User className="h-4 w-4" style={{ color: COLORS.inkFaint }} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold" style={{ color: COLORS.ink }}>
          {player.name}
        </div>
        <div className="truncate text-[11px]" style={{ color: COLORS.inkMuted }}>
          MLB • {event.matchupLabel}
        </div>
        <div className="truncate text-[10px]" style={{ color: COLORS.inkFaint }}>
          {formatStartTime(event.startTime)}
        </div>
      </div>
    </button>
  );
}

function StatCell({ row }: { row: PropsGridRow }) {
  return (
    <div
      className="flex items-center px-2 text-[12px] font-medium leading-tight"
      style={{ width: W.stat, minWidth: W.stat, height: ROW_H, color: COLORS.ink }}
    >
      <span className="line-clamp-3">{row.stat.shortLabel}</span>
    </div>
  );
}

function LineCell({ row, onClick }: { row: PropsGridRow; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center hover:opacity-90"
      style={{ width: W.line, minWidth: W.line, height: ROW_H, background: COLORS.anchorBg }}
    >
      <span className="text-[15px] font-bold" style={{ color: COLORS.ink }}>
        {formatLine(row.anchor.line)}
      </span>
    </button>
  );
}

// The recommended leg to bet for one side: the best price across books + the book,
// tinted green (bright when the pair locks an arb).
function BetCell({ row, side, onClick }: { row: PropsGridRow; side: "OVER" | "UNDER"; onClick: () => void }) {
  const leg = side === "OVER" ? row.arb?.over : row.arb?.under;
  const isArb = row.arb?.isArb ?? false;
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-0.5 hover:opacity-90"
      style={{ width: side === "OVER" ? W.betOver : W.betUnder, minWidth: side === "OVER" ? W.betOver : W.betUnder, height: ROW_H }}
    >
      {!leg ? (
        <span className="text-[12px]" style={{ color: COLORS.inkFaint }}>
          —
        </span>
      ) : (
        <>
          <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: isArb ? COLORS.pill : COLORS.inkFaint }}>
            {side === "OVER" ? "Over" : "Under"}
          </span>
          <span
            className="rounded px-2 py-0.5 text-[13px] font-bold"
            style={{ background: isArb ? COLORS.pill : "rgba(34,197,94,0.12)", color: isArb ? "#04231a" : COLORS.ink }}
          >
            {formatAmerican(leg.american)}
          </span>
          <span className="text-[10px] font-semibold" style={{ color: leg.available ? COLORS.inkMuted : "#f59e0b" }}>
            {getBook(leg.bookId)?.abbreviation ?? leg.bookId}
            {leg.available ? "" : " ⚠"}
          </span>
        </>
      )}
    </button>
  );
}

function EdgeCell({ row, onClick }: { row: PropsGridRow; onClick: () => void }) {
  const arb = row.arb;
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center hover:opacity-90"
      style={{ width: W.edge, minWidth: W.edge, height: ROW_H }}
    >
      {!arb || arb.edgePct == null ? (
        <span className="text-[12px]" style={{ color: COLORS.inkFaint }}>
          —
        </span>
      ) : arb.isArb ? (
        <span className="rounded px-1.5 py-1 text-[11px] font-bold" style={{ background: COLORS.pill, color: "#04231a" }}>
          ARB +{arb.edgePct.toFixed(1)}%
        </span>
      ) : (
        <span className="text-[11px] font-semibold" style={{ color: COLORS.inkMuted }}>
          {(arb.holdPct ?? 0).toFixed(1)}% hold
        </span>
      )}
    </button>
  );
}

// A book column: its over price (top) and under price (bottom) at the line. The BET
// legs (best over / best under book) get a green fill.
function TwoWayBookCell({ cell, onSelect }: { cell: TwoWayCell; onSelect: (q: DisplayQuote) => void }) {
  const { over, under } = cell;
  if (!over && !under) return <div style={{ width: W.book, minWidth: W.book, height: ROW_H }} />;
  const line = over?.line ?? under?.line ?? null;
  return (
    <div
      className="flex flex-col items-center justify-center gap-0.5"
      style={{ width: W.book, minWidth: W.book, height: ROW_H }}
    >
      <span className="text-[9px]" style={{ color: COLORS.inkFaint }}>
        {line == null ? "" : formatLine(line)}
      </span>
      <PriceRow q={over} label="O" onClick={onSelect} />
      <PriceRow q={under} label="U" onClick={onSelect} />
    </div>
  );
}

function PriceRow({ q, label, onClick }: { q: DisplayQuote | null; label: string; onClick: (q: DisplayQuote) => void }) {
  if (!q || q.americanOdds == null) {
    return (
      <span className="text-[11px]" style={{ color: COLORS.inkFaint }}>
        {label} —
      </span>
    );
  }
  const best = q.cellState === "best";
  const susp = !q.available || q.cellState === "suspended";
  return (
    <button
      onClick={() => onClick(q)}
      className="flex items-center gap-1 rounded px-1.5 hover:opacity-90"
      style={{ background: best ? COLORS.pill : "transparent", opacity: susp ? 0.5 : 1 }}
    >
      <span className="text-[8px] font-bold" style={{ color: best ? "#04231a" : COLORS.inkFaint }}>
        {label}
      </span>
      <span className="text-[11px] font-semibold" style={{ color: best ? "#04231a" : COLORS.ink }}>
        {formatAmerican(q.americanOdds)}
      </span>
    </button>
  );
}
