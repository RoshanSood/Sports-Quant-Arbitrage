"use client";

import { useMemo, useState } from "react";
import { Activity, RefreshCw, Search } from "lucide-react";
import type { ArbOpportunity, MarketType, NormalizedMarket, Outcome, VenueId } from "@/types/arbitrage";
import type { ArbReject } from "@/lib/arbitrage/arbEngine";
import { FloatingPanel, Pill } from "./ui";
import { venueDisplayName, venueStyle } from "./arbFormat";

type MonitorMarket = {
  key: string;
  marketType: MarketType;
  line: number | null;
  quotes: NormalizedMarket[];
  best: BestEdge | null;
  opportunity: ArbOpportunity | null;
  reject: ArbReject | null;
};

type MonitorGame = {
  key: string;
  matchup: string;
  sport: string;
  league: string;
  startTime: string;
  venueIds: VenueId[];
  markets: MonitorMarket[];
  bestEdge: number | null;
  bestOpportunity: ArbOpportunity | null;
};

type BestEdge = {
  totalCostCents: number;
  grossEdge: number;
  legs: NormalizedMarket[];
};

const MARKET_OPTIONS: Array<"all" | MarketType> = ["all", "moneyline", "total", "spread"];

export default function MarketMonitorPanel({
  markets,
  opportunities,
  rejects,
  live,
  scanning,
  refreshing,
  onRefresh,
  onClose,
}: {
  markets: NormalizedMarket[];
  opportunities: ArbOpportunity[];
  rejects: ArbReject[];
  live: boolean;
  scanning: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [marketFilter, setMarketFilter] = useState<"all" | MarketType>("all");
  const [arbOnly, setArbOnly] = useState(false);

  const games = useMemo(() => buildMonitorGames(markets, opportunities, rejects), [markets, opportunities, rejects]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games
      .map((game) => ({
        ...game,
        markets: game.markets.filter((m) => {
          if (marketFilter !== "all" && m.marketType !== marketFilter) return false;
          if (arbOnly && !m.opportunity) return false;
          return true;
        }),
      }))
      .filter((game) => {
        if (!game.markets.length) return false;
        if (!q) return true;
        return `${game.matchup} ${game.sport} ${game.league}`.toLowerCase().includes(q);
      });
  }, [arbOnly, games, marketFilter, query]);

  const trackedLines = games.reduce((sum, g) => sum + g.markets.length, 0);
  const liveArbLines = games.reduce((sum, g) => sum + g.markets.filter((m) => m.opportunity).length, 0);

  return (
    <FloatingPanel title="Market Monitor" subtitle={`${games.length} games - ${trackedLines} tracked lines`} onClose={onClose} width="max-w-7xl">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
          style={{
            background: live ? "#0d1a0f" : "#1a160e",
            color: live ? "#4ade80" : "#fbbf24",
            border: `1px solid ${live ? "#14532d" : "#3f2d10"}`,
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: scanning ? "#22c55e" : live ? "#84cc16" : "#f59e0b" }} />
          {scanning ? "LIVE LOOP" : live ? "LIVE CACHE" : "WAITING FOR SCAN"}
        </span>
        <Pill color="#22c55e" text="#86efac">arb lines {liveArbLines}</Pill>
        <Pill color="#3b82f6" text="#93c5fd">quotes {markets.length}</Pill>

        <div className="relative ml-0 sm:ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search game"
            className="w-56 pl-7 pr-2 py-1.5 rounded border text-xs text-gray-200 outline-none"
            style={{ background: "#0e1014", borderColor: "#1e2130" }}
          />
        </div>

        <div className="flex items-center gap-1 rounded border p-0.5" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
          {MARKET_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={() => setMarketFilter(m)}
              className="px-2 py-1 rounded text-[11px] font-semibold capitalize"
              style={{ background: marketFilter === m ? "#1f2937" : "transparent", color: marketFilter === m ? "#f9fafb" : "#6b7280" }}
            >
              {m === "all" ? "All" : m}
            </button>
          ))}
        </div>

        <button
          onClick={() => setArbOnly((v) => !v)}
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded border text-[11px] font-semibold"
          style={{ borderColor: arbOnly ? "#059669" : "#1e2130", color: arbOnly ? "#34d399" : "#9ca3af", background: arbOnly ? "#052e1b" : "#0e1014" }}
        >
          <Activity className="w-3.5 h-3.5" />
          Detected only
        </button>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded border text-[11px] font-semibold text-gray-200 disabled:opacity-60"
          style={{ borderColor: "#2a2d35", background: "#12151d" }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="space-y-3">
        {filtered.map((game) => (
          <GameCard key={game.key} game={game} />
        ))}
        {!filtered.length && (
          <div className="rounded border px-4 py-8 text-center text-xs text-gray-500" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
            No tracked lines match the current filters.
          </div>
        )}
      </div>
    </FloatingPanel>
  );
}

function GameCard({ game }: { game: MonitorGame }) {
  const [open, setOpen] = useState(true);
  const best = game.bestEdge;
  return (
    <div className="rounded border overflow-hidden" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-xs w-3">{open ? "v" : ">"}</span>
              <div className="font-semibold text-white truncate">{game.matchup}</div>
              {best != null && best > 0 && game.bestOpportunity && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: "#063d2a", color: "#34d399", border: "1px solid #047857" }}>
                  {marketLabelFromOpportunity(game.bestOpportunity)} +{(best * 100).toFixed(2)}%
                </span>
              )}
            </div>
            <div className="text-[10px] text-gray-500 ml-5">
              {game.sport} - {game.league.toUpperCase()} - {game.markets.length} lines - updated {ageLabel(Math.min(...game.markets.flatMap((m) => m.quotes.map((q) => Date.parse(q.lastUpdated)))))}
            </div>
          </div>
          <div className="flex justify-end gap-1 flex-wrap max-w-md shrink-0">{game.venueIds.map(venuePill)}</div>
        </div>
      </button>

      {open && (
        <div className="border-t overflow-x-auto" style={{ borderColor: "#1e2130" }}>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b" style={{ borderColor: "#1e2130" }}>
                <th className="px-4 py-2">Line</th>
                <th className="px-3 py-2">Best Cross-Venue Edge</th>
                <th className="px-3 py-2">Venue Prices</th>
                <th className="px-3 py-2 text-right">Age</th>
              </tr>
            </thead>
            <tbody>
              {game.markets.map((market) => (
                <MarketRow key={market.key} market={market} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MarketRow({ market }: { market: MonitorMarket }) {
  const best = market.best;
  const ageMs = Math.max(0, Date.now() - Math.min(...market.quotes.map((q) => Date.parse(q.lastUpdated))));
  const positive = (best?.grossEdge ?? 0) > 0;
  const displayLegs = market.opportunity?.legs ?? best?.legs ?? [];
  const displayCost = market.opportunity?.totalCostCents ?? best?.totalCostCents ?? 0;
  const displayEdge = market.opportunity?.netEdge ?? best?.grossEdge ?? 0;
  return (
    <tr className="border-b last:border-0 align-top" style={{ borderColor: "#15171e" }}>
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="font-semibold text-white">{marketLabel(market)}</div>
        <div className="text-[10px] text-gray-500">{market.quotes.length} quotes</div>
      </td>
      <td className="px-3 py-3 min-w-56">
        {best ? (
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold" style={{ color: market.opportunity ? "#34d399" : market.reject ? "#f59e0b" : positive ? "#9ca3af" : "#6b7280" }}>
                {market.opportunity ? "detected +" : positive ? "raw +" : ""}
                {(displayEdge * 100).toFixed(2)}%
              </span>
              <span className="text-gray-500">{displayCost.toFixed(2)}c cost</span>
              {market.opportunity && <Pill color="#f97316" text="#fdba74">detected</Pill>}
              {market.reject && <Pill color="#eab308" text="#fde68a">rejected</Pill>}
            </div>
            {displayLegs.length > 0 && (
              <div className="text-[10px] text-gray-300 mt-1">
                {displayLegs.map((leg) => `${venueDisplayName(leg.venueId)} ${displaySideLabel(leg, market)} ${leg.priceCents.toFixed(2)}c`).join(" + ")}
                {" = "}
                {displayCost.toFixed(2)}c
              </div>
            )}
            {market.reject && <div className="text-[10px] text-amber-300 mt-1">{rejectLabel(market.reject)}</div>}
            <div className="flex flex-wrap gap-1 mt-1">
              {best.legs.map((leg) => (
                <span key={leg.marketId} className="text-[10px] text-gray-400">
                  {venueDisplayName(leg.venueId)} {sideLabel(leg)} {leg.priceCents.toFixed(2)}c
                </span>
              ))}
            </div>
          </div>
        ) : (
          <span className="text-gray-600">No complete cross-venue set</span>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          {groupQuotesByVenue(market.quotes).map(([venueId, quotes]) => (
            <VenueQuoteBox key={venueId} venueId={venueId} quotes={quotes} marketType={market.marketType} />
          ))}
        </div>
      </td>
      <td className="px-3 py-3 text-right text-gray-500 whitespace-nowrap">{ageMsLabel(ageMs)}</td>
    </tr>
  );
}

function VenueQuoteBox({ venueId, quotes, marketType }: { venueId: VenueId; quotes: NormalizedMarket[]; marketType: MarketType }) {
  return (
    <div className="rounded border px-2.5 py-2" style={{ borderColor: "#1e2130", background: "#10131a" }}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        {venuePill(venueId)}
        <span className="text-[10px] text-gray-600">{quotes.some((q) => q.live) ? "live" : "cached"}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {outcomeOrder(marketType, quotes).map((outcome) => {
          const q = quotes.find((quote) => quote.outcome === outcome);
          return (
            <div key={outcome} className="rounded px-2 py-1" style={{ background: "#0b0d12" }}>
              <div className="text-[9px] uppercase text-gray-600">{outcomeLabel(outcome, q)}</div>
              <div className="text-xs font-bold text-gray-100">{q ? `${q.priceCents.toFixed(2)}c` : "-"}</div>
              <div className="text-[9px] text-gray-600">{q ? `$${Math.round(q.liquidityUsd)} avail` : ""}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildMonitorGames(markets: NormalizedMarket[], opportunities: ArbOpportunity[], rejects: ArbReject[]): MonitorGame[] {
  const openMarkets = markets.filter((m) => m.status === "open");
  const oppByKey = new Map(opportunities.map((opp) => [opportunityLookupKey(opp), opp]));
  const rejectByKey = new Map(rejects.map((reject) => [rejectLookupKey(reject), reject]));
  const byGame = new Map<string, NormalizedMarket[]>();
  for (const market of openMarkets) {
    const key = `${market.sport}:${market.league}:${market.teams.join("|")}:${market.startTime}`;
    const list = byGame.get(key) ?? [];
    list.push(market);
    byGame.set(key, list);
  }

  return [...byGame.entries()]
    .map(([key, gameMarkets]) => {
      const first = gameMarkets[0];
      const byLine = new Map<string, NormalizedMarket[]>();
      for (const market of gameMarkets) {
        const lineKey = monitorMarketKey(market);
        const list = byLine.get(lineKey) ?? [];
        list.push(market);
        byLine.set(lineKey, list);
      }
      const monitorMarkets = [...byLine.entries()]
        .map(([lineKey, quotes]) => {
          const firstQuote = quotes[0];
          const opp = oppByKey.get(lineKey) ?? null;
          return {
            key: lineKey,
            marketType: firstQuote.marketType,
            line: firstQuote.line,
            quotes: sortQuotes(quotes),
            best: bestCrossVenueEdge(quotes, firstQuote.marketType),
            opportunity: opp,
            reject: rejectByKey.get(rejectLookupKeyFromMarket(firstQuote)) ?? null,
          };
        })
        .sort(compareMonitorMarkets);
      const venueIds = [...new Set(gameMarkets.map((m) => m.venueId))].sort();
      const bestOpportunity =
        monitorMarkets
          .map((m) => m.opportunity)
          .filter((o): o is ArbOpportunity => Boolean(o))
          .sort((a, b) => b.netEdge - a.netEdge)[0] ?? null;
      const bestEdge = bestOpportunity?.netEdge ?? null;
      return {
        key,
        matchup: `${first.teams[0]} v ${first.teams[1]}`,
        sport: first.sport,
        league: first.league,
        startTime: first.startTime,
        venueIds,
        markets: monitorMarkets,
        bestEdge: bestEdge != null && Number.isFinite(bestEdge) && bestEdge > 0 ? bestEdge : null,
        bestOpportunity,
      };
    })
    .sort((a, b) => (b.bestEdge ?? -1) - (a.bestEdge ?? -1) || a.matchup.localeCompare(b.matchup));
}

function monitorMarketKey(market: NormalizedMarket): string {
  return `${market.sport}:${market.league}:${normalizedTeamsKey(market.teams)}:${market.marketType}:${market.line ?? "ml"}`;
}

function opportunityLookupKey(opp: ArbOpportunity): string {
  const eventParts = opp.eventKey.split(":");
  const sport = eventParts[0] ?? "";
  const league = eventParts[1] ?? "";
  const teams = opp.matchup.split(/\s+v\s+/i);
  return `${sport}:${league}:${normalizedTeamsKey(teams)}:${opp.marketType}:${opp.line ?? "ml"}`;
}

function rejectLookupKey(reject: ArbReject): string {
  const eventParts = reject.eventKey.split(":");
  const sport = eventParts[0] ?? "";
  const league = eventParts[1] ?? "";
  const teams = reject.matchup.split(/\s+v\s+/i);
  const line = reject.marketType === "moneyline" || reject.line == null || reject.line === 0 ? "ml" : reject.line;
  return `${sport}:${league}:${normalizedTeamsKey(teams)}:${reject.marketType}:${line}`;
}

function rejectLookupKeyFromMarket(market: NormalizedMarket): string {
  const line = market.marketType === "moneyline" || market.line == null || market.line === 0 ? "ml" : market.line;
  return `${market.sport}:${market.league}:${normalizedTeamsKey(market.teams)}:${market.marketType}:${line}`;
}

function normalizedTeamsKey(teams: readonly string[]): string {
  return teams.map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).sort().join("|");
}

function bestCrossVenueEdge(quotes: NormalizedMarket[], marketType: MarketType): BestEdge | null {
  const outcomes = requiredOutcomes(marketType, quotes);
  if (outcomes.length < 2) return null;
  const byOutcome = outcomes.map((outcome) => quotes.filter((q) => q.outcome === outcome).sort((a, b) => a.priceCents - b.priceCents));
  if (byOutcome.some((list) => list.length === 0)) return null;

  let best: NormalizedMarket[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  const walk = (idx: number, selected: NormalizedMarket[]) => {
    if (idx === byOutcome.length) {
      if (new Set(selected.map((q) => q.venueId)).size < 2) return;
      const cost = selected.reduce((sum, q) => sum + q.priceCents, 0);
      if (cost < bestCost) {
        best = selected;
        bestCost = cost;
      }
      return;
    }
    for (const quote of byOutcome[idx].slice(0, 8)) walk(idx + 1, [...selected, quote]);
  };
  walk(0, []);
  const bestLegs: NormalizedMarket[] = best ?? [];
  if (!bestLegs.length) return null;
  const totalCostCents = bestLegs.reduce((sum, q) => sum + q.priceCents, 0);
  return { totalCostCents, grossEdge: (100 - totalCostCents) / totalCostCents, legs: bestLegs };
}

function requiredOutcomes(marketType: MarketType, quotes: NormalizedMarket[]): Outcome[] {
  if (marketType === "total") return ["over", "under"];
  if (marketType === "spread") return ["home", "away"];
  // Match the engine: soccer moneyline is 3-way (home/draw/away) decided by SPORT, not by
  // whether a draw quote happens to be present. A soccer home/away-only pair is not an arb
  // (the draw would lose both legs), so requiring the draw leg here suppresses phantom raw edges.
  return quotes.some((q) => q.sport === "soccer") ? ["home", "draw", "away"] : ["home", "away"];
}

function outcomeOrder(marketType: MarketType, quotes: NormalizedMarket[]): Outcome[] {
  return requiredOutcomes(marketType, quotes);
}

function groupQuotesByVenue(quotes: NormalizedMarket[]): Array<[VenueId, NormalizedMarket[]]> {
  const map = new Map<VenueId, NormalizedMarket[]>();
  for (const quote of quotes) {
    const list = map.get(quote.venueId) ?? [];
    list.push(quote);
    map.set(quote.venueId, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function sortQuotes(quotes: NormalizedMarket[]) {
  return [...quotes].sort((a, b) => a.venueId.localeCompare(b.venueId) || a.outcome.localeCompare(b.outcome));
}

function compareMonitorMarkets(a: MonitorMarket, b: MonitorMarket) {
  const typeOrder: Record<MarketType, number> = { moneyline: 0, total: 1, spread: 2 };
  return typeOrder[a.marketType] - typeOrder[b.marketType] || (a.line ?? -999) - (b.line ?? -999);
}

function venuePill(v: string) {
  const s = venueStyle(v);
  return (
    <Pill key={v} color={s.color} text={s.text}>
      {venueDisplayName(v)}
    </Pill>
  );
}

function marketLabel(market: MonitorMarket) {
  if (market.marketType === "moneyline") return "Moneyline";
  if (market.marketType === "total") return `Total ${market.line}`;
  return `Spread ${market.line}`;
}

function marketLabelFromOpportunity(opp: ArbOpportunity) {
  if (opp.marketType === "moneyline") return "ML";
  if (opp.marketType === "total") return `Total ${opp.line}`;
  return `Spread ${opp.line}`;
}

function displaySideLabel(leg: { outcome: Outcome; label?: string }, market: MonitorMarket) {
  if (leg.label) return leg.label;
  return `${leg.outcome}${market.line != null ? ` ${market.line}` : ""}`;
}

function sideLabel(market: NormalizedMarket) {
  if (market.marketType === "total") return `${market.outcome} ${market.line}`;
  if (market.marketType === "spread") return market.outcome === "home" ? `${market.teams[1]} ${market.line}` : `${market.teams[0]} ${-(market.line ?? 0)}`;
  if (market.outcome === "home") return market.teams[1];
  if (market.outcome === "away") return market.teams[0];
  return "Draw";
}

function outcomeLabel(outcome: Outcome, quote?: NormalizedMarket) {
  if (!quote) return outcome;
  return sideLabel(quote);
}

function ageMsLabel(ms: number) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function ageLabel(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "-";
  return `${ageMsLabel(Date.now() - timestamp)} ago`;
}

function rejectLabel(reject: ArbReject) {
  if (reject.reason === "stale_quote") return `Raw gap blocked: ${reject.detail}`;
  if (reject.reason === "insufficient_depth") return `Not executable: ${reject.detail}`;
  if (reject.reason === "edge_below_min") return `Too small after sizing/fees: ${reject.detail}`;
  if (reject.reason === "edge_above_max") return `Outside max-edge safety: ${reject.detail}`;
  return `${reject.reason}: ${reject.detail}`;
}
