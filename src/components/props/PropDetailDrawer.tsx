"use client";

// Detail drawer — the audit surface (manual §9.2, §11). Shows every exact-line
// quote, timestamps, the consensus/confidence breakdown, the calculation trace
// (included + rejected quote IDs, thresholds, confidence components), and a
// provider deeplink when supplied. Everything here must be reproducible from stored
// quote IDs + the method version.

import { useState } from "react";
import { Copy, X } from "lucide-react";
import type { ArbLegPick, BookSummary, DisplayQuote, PropsGridRow } from "@/types/props";
import { getBook } from "@/lib/props/books";
import { formatAmerican, formatLine, formatProbability, reasonLabel, relativeAge } from "@/lib/props/format";
import { COLORS } from "./gridConfig";

type Props = {
  row: PropsGridRow;
  focusedQuote: DisplayQuote | null;
  books: BookSummary[];
  onClose: () => void;
};

function ArbLeg({ label, leg }: { label: string; leg: ArbLegPick | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase" style={{ color: COLORS.inkFaint }}>
        {label}
      </div>
      {leg ? (
        <div className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-bold" style={{ color: COLORS.ink }}>
            {formatAmerican(leg.american)}
          </span>
          <span className="text-[11px]" style={{ color: COLORS.inkMuted }}>
            {getBook(leg.bookId)?.abbreviation ?? leg.bookId}
          </span>
          {!leg.available ? (
            <span className="text-[9px] font-semibold" style={{ color: "#f59e0b" }}>
              susp
            </span>
          ) : null}
        </div>
      ) : (
        <span className="text-[13px]" style={{ color: COLORS.inkFaint }}>
          —
        </span>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.inkFaint }}>
        {label}
      </span>
      <span className="text-[14px] font-semibold" style={{ color: COLORS.ink }}>
        {value}
      </span>
    </div>
  );
}

export default function PropDetailDrawer({ row, focusedQuote, books, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const arb = row.arb;

  // Per-book over/under rows for the quote table.
  const bookRows = books
    .map((b) => ({ book: b, cell: row.twoWayCells[b.bookId] }))
    .filter((r) => r.cell && (r.cell.over || r.cell.under));

  function copySummary() {
    const line = formatLine(row.anchor.line);
    const over = arb?.over ? `${formatAmerican(arb.over.american)} @ ${getBook(arb.over.bookId)?.abbreviation}` : "—";
    const under = arb?.under ? `${formatAmerican(arb.under.american)} @ ${getBook(arb.under.bookId)?.abbreviation}` : "—";
    const edge = arb?.isArb ? `ARB +${arb.edgePct?.toFixed(2)}%` : `${(arb?.holdPct ?? 0).toFixed(2)}% hold`;
    const lines = [
      `${row.player.name} — ${row.stat.label} ${line} (${row.event.matchupLabel})`,
      `Over ${over}  |  Under ${under}  →  ${edge}`,
    ];
    navigator.clipboard?.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative flex h-full w-full max-w-md flex-col overflow-auto border-l"
        style={{ background: "#03181d", borderColor: COLORS.divider }}
      >
        {/* Header */}
        <div className="sticky top-0 flex items-start justify-between border-b p-4" style={{ background: "#03181d", borderColor: COLORS.divider }}>
          <div>
            <div className="text-[16px] font-bold" style={{ color: COLORS.ink }}>
              {row.player.name}
            </div>
            <div className="text-[12px]" style={{ color: COLORS.inkMuted }}>
              MLB • {row.event.matchupLabel} · {row.stat.label}
            </div>
            <div className="mt-1 text-[12px] font-semibold" style={{ color: COLORS.inkMuted }}>
              Two-way market · line {formatLine(row.anchor.line)}
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/10">
            <X className="h-4 w-4" style={{ color: COLORS.inkMuted }} />
          </button>
        </div>

        {/* Flags */}
        {row.flags.length ? (
          <div className="flex flex-wrap gap-1.5 px-4 pt-4">
            {row.flags.map((f) => (
              <span
                key={f}
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ background: "rgba(56,189,248,0.12)", color: "#7dd3fc" }}
              >
                {reasonLabel(f)}
              </span>
            ))}
          </div>
        ) : null}

        {/* Two-way arbitrage (odds discrepancy) */}
        {row.arb ? (
          <div className="px-4 pt-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.inkFaint }}>
              Two-way market · line {formatLine(row.arb.line)}
            </div>
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: row.arb.isArb ? COLORS.pill : COLORS.divider,
                background: row.arb.isArb ? "rgba(34,197,94,0.06)" : "transparent",
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <ArbLeg label="Best Over" leg={row.arb.over} />
                <ArbLeg label="Best Under" leg={row.arb.under} />
              </div>
              <div className="mt-3 flex items-center justify-between border-t pt-3" style={{ borderColor: COLORS.divider }}>
                <div>
                  <div className="text-[10px] uppercase" style={{ color: COLORS.inkFaint }}>
                    Combined implied
                  </div>
                  <div className="text-[14px] font-semibold" style={{ color: COLORS.ink }}>
                    {row.arb.combinedImplied != null ? `${(row.arb.combinedImplied * 100).toFixed(1)}%` : "—"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase" style={{ color: COLORS.inkFaint }}>
                    {row.arb.isArb ? "Arb profit" : "Two-way hold"}
                  </div>
                  <div className="text-[16px] font-bold" style={{ color: row.arb.isArb ? COLORS.pill : COLORS.inkMuted }}>
                    {row.arb.isArb ? `+${row.arb.edgePct?.toFixed(2)}%` : `${(row.arb.holdPct ?? 0).toFixed(2)}%`}
                  </div>
                </div>
              </div>
              {row.arb.isArb && row.arb.stake && row.arb.combinedImplied ? (
                <div className="mt-2 text-[11px]" style={{ color: COLORS.inkMuted }}>
                  $100 pair: <strong style={{ color: COLORS.ink }}>${(row.arb.stake.overPct * 100).toFixed(0)}</strong> over @{" "}
                  {getBook(row.arb.over!.bookId)?.abbreviation}, <strong style={{ color: COLORS.ink }}>${(row.arb.stake.underPct * 100).toFixed(0)}</strong>{" "}
                  under @ {getBook(row.arb.under!.bookId)?.abbreviation} → locked{" "}
                  <strong style={{ color: COLORS.pill }}>${(100 * (1 / row.arb.combinedImplied - 1)).toFixed(2)}</strong>.
                </div>
              ) : (
                <div className="mt-2 text-[10px]" style={{ color: COLORS.inkFaint }}>
                  Not a locked arb — the two best prices still carry a {(row.arb.holdPct ?? 0).toFixed(1)}% hold. Useful for line-shopping each side.
                </div>
              )}
              {(row.arb.over && !row.arb.over.available) || (row.arb.under && !row.arb.under.available) ? (
                <div className="mt-1 text-[10px]" style={{ color: "#f59e0b" }}>
                  ⚠ One or both best legs are suspended — not executable until markets reopen.
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Fair-value model (secondary; Phase 2 focus) */}
        <div className="px-4 pt-4 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.inkFaint }}>
          Fair value (model)
        </div>
        <div className="grid grid-cols-3 gap-4 px-4 pb-4 pt-2">
          <Stat label="Fair over prob" value={formatProbability(row.fairHitProbability)} />
          <Stat label="Fair over odds" value={row.fairAmericanOdds == null ? "—" : formatAmerican(row.fairAmericanOdds)} />
          <Stat label="Confidence" value={row.confidence.toFixed(2)} />
        </div>

        {/* Per-book over / under prices */}
        <div className="px-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.inkFaint }}>
            All book prices · over / under
          </div>
          <div className="overflow-hidden rounded-lg border" style={{ borderColor: COLORS.divider }}>
            {bookRows.map(({ book, cell }, i) => {
              const isOverBet = arb?.over?.bookId === book.bookId;
              const isUnderBet = arb?.under?.bookId === book.bookId;
              const focused = focusedQuote && (focusedQuote.quoteId === cell.over?.quoteId || focusedQuote.quoteId === cell.under?.quoteId);
              const price = (q: typeof cell.over, isBet: boolean) =>
                !q || q.americanOdds == null ? (
                  <span style={{ color: COLORS.inkFaint }}>—</span>
                ) : (
                  <span
                    className={isBet ? "rounded px-1.5 font-bold" : "font-semibold"}
                    style={isBet ? { background: COLORS.pill, color: "#04231a" } : { color: q.available ? COLORS.ink : "#f59e0b" }}
                  >
                    {formatAmerican(q.americanOdds)}
                  </span>
                );
              return (
                <div
                  key={book.bookId}
                  className="grid grid-cols-[64px_1fr_1fr_auto] items-center gap-2 px-3 py-2 text-[12px]"
                  style={{ background: focused ? "#0b3a46" : i % 2 ? "#04222a" : "transparent", borderTop: i ? `1px solid ${COLORS.divider}` : undefined }}
                >
                  <span className="font-semibold" style={{ color: COLORS.ink }}>
                    {book.abbreviation}
                  </span>
                  <span style={{ color: COLORS.inkMuted }}>O {price(cell.over, isOverBet)}</span>
                  <span style={{ color: COLORS.inkMuted }}>U {price(cell.under, isUnderBet)}</span>
                  <span className="text-[10px]" style={{ color: COLORS.inkFaint }}>
                    {relativeAge(cell.over?.observedAt ?? cell.under?.observedAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Calculation trace */}
        {row.trace ? (
          <div className="p-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.inkFaint }}>
              Calculation trace · {row.trace.methodVersion}
            </div>
            <div className="space-y-2 rounded-lg border p-3 text-[11px]" style={{ borderColor: COLORS.divider, color: COLORS.inkMuted }}>
              <div>
                <span style={{ color: COLORS.inkFaint }}>Included quotes: </span>
                {row.trace.includedQuoteIds.length}
              </div>
              <div>
                <span style={{ color: COLORS.inkFaint }}>Rejected: </span>
                {row.trace.rejectedQuoteIds.length
                  ? row.trace.rejectedQuoteIds.map((r) => `${r.reason}`).join(", ")
                  : "none"}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(row.trace.confidenceComponents).map(([k, v]) => (
                  <span key={k}>
                    <span style={{ color: COLORS.inkFaint }}>{k}: </span>
                    {v.toFixed(2)}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(row.trace.thresholds).map(([k, v]) => (
                  <span key={k}>
                    <span style={{ color: COLORS.inkFaint }}>{k}: </span>
                    {v}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* Actions */}
        <div className="mt-auto flex gap-2 border-t p-4" style={{ borderColor: COLORS.divider }}>
          <button
            onClick={copySummary}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-[13px] font-semibold"
            style={{ background: "#0b3a46", color: COLORS.ink }}
          >
            <Copy className="h-4 w-4" />
            {copied ? "Copied" : "Copy arb summary"}
          </button>
        </div>
      </div>
    </div>
  );
}
