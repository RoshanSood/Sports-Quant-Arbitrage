"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertTriangle, BarChart2, ChevronLeft, ChevronRight } from "lucide-react";
import type { GameMarketRow, MarketPrice, MarketsResponse } from "@/app/api/markets/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoToYYYYMMDD(iso: string): string {
  return iso.replace(/-/g, "");
}

function formatDateLabel(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function cents(p: number): string {
  return `${Math.round(p * 100)}¢`;
}

function amerOdds(p: number): string {
  if (p <= 0 || p >= 1) return "";
  if (p >= 0.5) return `-${Math.round((p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
}

function betterSide(a: MarketPrice | null, b: MarketPrice | null): "a" | "b" | "tie" | null {
  if (!a && !b) return null;
  if (!a) return "b";
  if (!b) return "a";
  if (a.probability < b.probability) return "a";
  if (b.probability < a.probability) return "b";
  return "tie";
}

// Grid column template — shared by header and every game row so columns stay aligned
const COLS = "minmax(180px,1fr) 110px 110px 130px";

// ── Sub-components ────────────────────────────────────────────────────────────

function DateSelector({ date, onChange }: { date: string; onChange: (iso: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => onChange(shiftDate(date, -1))}
        className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <input
        type="date"
        value={date}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-1 focus:ring-blue-500"
        style={{ background: "#13161e", border: "1px solid #2e3347" }}
      />
      <button
        onClick={() => onChange(shiftDate(date, 1))}
        className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
      <span className="text-gray-400 text-sm hidden sm:block">{formatDateLabel(date)}</span>
    </div>
  );
}

function TeamLogo({ src, alt }: { src: string; alt: string }) {
  const [err, setErr] = useState(false);
  if (err || !src) {
    return (
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-gray-400 shrink-0"
        style={{ background: "#1e2130" }}
      >
        {alt.slice(0, 2)}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className="w-6 h-6 object-contain shrink-0" onError={() => setErr(true)} />
  );
}

function PriceBox({ price, isBest }: { price: MarketPrice | null; isBest: boolean }) {
  if (!price) return <div className="flex items-center justify-center"><span className="text-gray-600 text-xs">N/A</span></div>;
  return (
    <div className="flex items-center justify-center">
      <div
        className={`inline-flex flex-col items-center rounded-lg px-2.5 py-1 ${
          isBest ? "bg-green-400/10 ring-1 ring-green-400/30" : ""
        }`}
      >
        <span className={`text-sm font-bold tabular-nums ${isBest ? "text-green-400" : "text-white"}`}>
          {cents(price.probability)}
        </span>
        <span className="text-xs tabular-nums" style={{ color: "#64748b" }}>
          {amerOdds(price.probability)}
        </span>
      </div>
    </div>
  );
}

function BestBox({ kalshi, poly, source }: {
  kalshi: MarketPrice | null;
  poly: MarketPrice | null;
  source: "a" | "b" | "tie" | null;
}) {
  if (!source) return <div className="flex items-center justify-center"><span className="text-gray-600 text-xs">—</span></div>;
  const best = source === "a" ? kalshi! : poly!;
  const label = source === "a" ? "Kalshi" : source === "b" ? "Poly" : "Tied";
  return (
    <div className="flex items-center justify-center">
      <div className="inline-flex flex-col items-center">
        <span className="text-green-400 text-sm font-bold tabular-nums">{cents(best.probability)}</span>
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium mt-0.5"
          style={{ background: "#0d2b1a", color: "#4ade80" }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

// ── Desktop: one card per game with two inner rows ────────────────────────────

function GameCardDesktop({ row }: { row: GameMarketRow }) {
  const awayBetter = betterSide(row.kalshi.away, row.polymarket.away);
  const homeBetter = betterSide(row.kalshi.home, row.polymarket.home);

  const statusBadge =
    row.status === "In Progress" ? (
      <span className="text-xs font-semibold text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded-full">
        LIVE
      </span>
    ) : row.status === "Final" ? (
      <span className="text-xs text-gray-600">Final</span>
    ) : (
      <span className="text-xs text-gray-400">{row.startTime}</span>
    );

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ border: "1px solid #2e3347", background: "#13161e" }}
    >
      {/* Away row */}
      <div
        className="grid items-center px-4 py-3"
        style={{ gridTemplateColumns: COLS, borderBottom: "1px solid #1e2130" }}
      >
        {/* Team */}
        <div className="flex items-center gap-2 min-w-0">
          <TeamLogo src={row.awayTeam.logo} alt={row.awayTeam.abbreviation} />
          <span className="text-white text-sm font-semibold">{row.awayTeam.abbreviation}</span>
          <span className="text-gray-500 text-xs">{row.awayTeam.record}</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded-full"
            style={{ background: "#1e2130", color: "#64748b" }}
          >
            Away
          </span>
        </div>
        <PriceBox price={row.kalshi.away} isBest={awayBetter === "a"} />
        <PriceBox price={row.polymarket.away} isBest={awayBetter === "b"} />
        <BestBox kalshi={row.kalshi.away} poly={row.polymarket.away} source={awayBetter} />
      </div>

      {/* Home row */}
      <div
        className="grid items-center px-4 py-3"
        style={{ gridTemplateColumns: COLS }}
      >
        {/* Team */}
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <TeamLogo src={row.homeTeam.logo} alt={row.homeTeam.abbreviation} />
          <span className="text-white text-sm font-semibold">{row.homeTeam.abbreviation}</span>
          <span className="text-gray-500 text-xs">{row.homeTeam.record}</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded-full"
            style={{ background: "#1e2130", color: "#64748b" }}
          >
            Home
          </span>
          <span className="ml-1">{statusBadge}</span>
          {row.polymarket.volume && (
            <span className="text-xs text-gray-600">· {row.polymarket.volume}</span>
          )}
        </div>
        <PriceBox price={row.kalshi.home} isBest={homeBetter === "a"} />
        <PriceBox price={row.polymarket.home} isBest={homeBetter === "b"} />
        <BestBox kalshi={row.kalshi.home} poly={row.polymarket.home} source={homeBetter} />
      </div>
    </div>
  );
}

// ── Mobile: compact card per game ─────────────────────────────────────────────

function GameCardMobile({ row }: { row: GameMarketRow }) {
  const awayBetter = betterSide(row.kalshi.away, row.polymarket.away);
  const homeBetter = betterSide(row.kalshi.home, row.polymarket.home);

  function TeamPriceRow({
    logo, abbr, record, side, kalshi, poly, better, divider,
  }: {
    logo: string; abbr: string; record: string; side: string;
    kalshi: MarketPrice | null; poly: MarketPrice | null;
    better: "a" | "b" | "tie" | null; divider?: boolean;
  }) {
    return (
      <div
        className="flex items-center gap-2 py-2.5"
        style={divider ? { borderBottom: "1px solid #1e2130" } : {}}
      >
        <TeamLogo src={logo} alt={abbr} />
        <div className="flex flex-col min-w-[60px]">
          <span className="text-white text-sm font-semibold">{abbr}</span>
          <span className="text-gray-600 text-xs">{record} · {side}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex flex-col items-center">
            <span className="text-gray-500 text-xs mb-0.5">Kalshi</span>
            {kalshi
              ? <span className={`text-sm font-bold tabular-nums ${better === "a" ? "text-green-400" : "text-white"}`}>{cents(kalshi.probability)}</span>
              : <span className="text-gray-600 text-xs">N/A</span>}
          </div>
          <div className="flex flex-col items-center">
            <span className="text-gray-500 text-xs mb-0.5">Poly</span>
            {poly
              ? <span className={`text-sm font-bold tabular-nums ${better === "b" ? "text-green-400" : "text-white"}`}>{cents(poly.probability)}</span>
              : <span className="text-gray-600 text-xs">N/A</span>}
          </div>
          {better && better !== "tie" && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: "#0d2b1a", color: "#4ade80" }}>
              {better === "a" ? "Kalshi" : "Poly"}
            </span>
          )}
        </div>
      </div>
    );
  }

  const statusLabel = row.status === "In Progress" ? "🔴 LIVE" : row.status === "Final" ? "Final" : row.startTime;

  return (
    <div className="rounded-xl px-4 py-2" style={{ background: "#13161e", border: "1px solid #2e3347" }}>
      <div className="text-xs text-gray-500 pt-2 pb-1 font-medium">{statusLabel}</div>
      <TeamPriceRow logo={row.awayTeam.logo} abbr={row.awayTeam.abbreviation} record={row.awayTeam.record}
        side="Away" kalshi={row.kalshi.away} poly={row.polymarket.away} better={awayBetter} divider />
      <TeamPriceRow logo={row.homeTeam.logo} abbr={row.homeTeam.abbreviation} record={row.homeTeam.record}
        side="Home" kalshi={row.kalshi.home} poly={row.polymarket.home} better={homeBetter} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MLBMoneylineDashboard() {
  const [date, setDate] = useState<string>(todayISO());
  const [rows, setRows] = useState<GameMarketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (isoDate: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/markets?date=${isoToYYYYMMDD(isoDate)}`);
      const data: MarketsResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setRows(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load markets");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(date);
  }, [date, loadData]);

  const hasAnyKalshi = rows.some((r) => r.kalshi.away || r.kalshi.home);
  const hasAnyPoly   = rows.some((r) => r.polymarket.away || r.polymarket.home);

  return (
    <div className="min-h-screen" style={{ background: "#0e1014" }}>
      <div className="max-w-5xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-blue-400" />
              <h1 className="text-xl font-bold text-white">Moneyline Markets</h1>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: "#1e2130", color: "#94a3b8" }}>
                MLB · Kalshi vs Polymarket
              </span>
            </div>
            <p className="text-gray-500 text-sm mt-0.5">
              Compare moneyline prices · lower ¢ = better value for buyer
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DateSelector date={date} onChange={setDate} />
            <button onClick={() => loadData(date)} className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <AlertTriangle className="w-8 h-8 text-red-400" />
            <p className="text-red-400 font-medium">{error}</p>
            <button onClick={() => loadData(date)} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg">Retry</button>
          </div>
        )}

        {/* No games */}
        {!loading && !error && rows.length === 0 && (
          <div className="rounded-xl p-12 text-center" style={{ background: "#13161e", border: "1px solid #1e2130" }}>
            <BarChart2 className="w-10 h-10 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400 font-medium">No MLB games found for this date</p>
            <p className="text-gray-600 text-sm mt-1">Try selecting another date</p>
          </div>
        )}

        {/* Source warnings */}
        {!loading && !error && rows.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {!hasAnyKalshi && (
              <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full" style={{ background: "#1a0e0e", border: "1px solid #3d1515", color: "#f87171" }}>
                <AlertTriangle className="w-3 h-3" /> Kalshi markets not yet available for this date
              </div>
            )}
            {!hasAnyPoly && (
              <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full" style={{ background: "#1a0e0e", border: "1px solid #3d1515", color: "#f87171" }}>
                <AlertTriangle className="w-3 h-3" /> Polymarket markets not yet available for this date
              </div>
            )}
          </div>
        )}

        {/* Desktop: column header + game cards */}
        {!loading && !error && rows.length > 0 && (
          <>
            <div className="hidden md:block space-y-2">
              {/* Column header */}
              <div
                className="grid items-center px-4 py-2"
                style={{ gridTemplateColumns: COLS }}
              >
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Team</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-center" style={{ color: "#60a5fa" }}>Kalshi</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-center" style={{ color: "#a78bfa" }}>Polymarket</span>
                <span className="text-xs font-semibold text-green-500 uppercase tracking-wider text-center">Best Price</span>
              </div>
              {/* Game cards */}
              {rows.map((row) => (
                <GameCardDesktop key={row.gameId} row={row} />
              ))}
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {rows.map((row) => (
                <GameCardMobile key={row.gameId} row={row} />
              ))}
            </div>
          </>
        )}

        {!loading && rows.length > 0 && (
          <p className="text-gray-600 text-xs mt-4 text-center">
            Prices in cents (¢) · ask price to buy YES · lower = cheaper · Kalshi public data · Polymarket via Gamma API
          </p>
        )}
      </div>
    </div>
  );
}
