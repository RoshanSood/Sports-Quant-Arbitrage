"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  ArbLog,
  ArbOpportunity,
  MainLineWatch,
  MatchMapData,
  NormalizedMarket,
  RiskSettings,
  Trade,
  Venue,
} from "@/types/arbitrage";
import {
  MOCK_LOGS,
  MOCK_MARKETS,
  MOCK_OPPORTUNITIES,
  MOCK_TRADES,
  MOCK_VENUES,
  DEFAULT_AGENT,
} from "@/lib/arbitrage/mockData";
import { DEFAULT_RISK } from "@/lib/arbitrage/seed";
import ClawArbsTopBar from "./ClawArbsTopBar";
import ArenaCanvas, { type AgentTrade, type BookEdge } from "./ArenaCanvas";
import ArbsPanel from "./ArbsPanel";
import PortfolioPanel from "./PortfolioPanel";
import RiskPanel from "./RiskPanel";
import MatchMapPanel from "./MatchMapPanel";
import ArbLogPanel from "./ArbLogPanel";
import AgentDrawer from "./AgentDrawer";
import VenueDrawer from "./VenueDrawer";
import PlayModal from "./PlayModal";
import AnalyticsPanel from "./AnalyticsPanel";

export type PanelKey = "arbs" | "portfolio" | "risk" | "log" | "matchmap" | "analytics";

// Phase 1 renders from mock data. Flip to false once the /api/arbitrage routes are
// populated to fetch live state instead. Kept as a single switch for a clean handoff.
const USE_MOCK = true;

// Auto-scan cadence while Scanning is on. Each scan re-ingests both venues (~11MB
// Polymarket pull), so keep it modest to avoid hammering the public APIs.
const SCAN_INTERVAL_MS = 45000;

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export default function ArbitrageClient() {
  const [venues, setVenues] = useState<Venue[]>(MOCK_VENUES);
  const [agent, setAgent] = useState<Agent>(DEFAULT_AGENT);
  const [opportunities, setOpportunities] = useState<ArbOpportunity[]>(MOCK_OPPORTUNITIES);
  const [trades, setTrades] = useState<Trade[]>(MOCK_TRADES);
  const [logs, setLogs] = useState<ArbLog[]>(MOCK_LOGS);
  const [risk, setRisk] = useState<RiskSettings>({
    ...DEFAULT_RISK,
    currentExposure: 647,
    dailyPnl: 14.3,
  });
  // Live normalized markets (Phase 3 ingestion). Starts on mock fixtures so the
  // dashboard is never blank, and is replaced with real Kalshi/Polymarket totals
  // once ingestion returns data.
  const [markets, setMarkets] = useState<NormalizedMarket[]>(MOCK_MARKETS);
  const [marketsLive, setMarketsLive] = useState(false);
  const [oppsLive, setOppsLive] = useState(false);
  const [portfolioLive, setPortfolioLive] = useState(false);
  const [matchMap, setMatchMap] = useState<MatchMapData | null>(null);
  const [watch, setWatch] = useState<MainLineWatch[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [panel, setPanel] = useState<PanelKey | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [openVenueId, setOpenVenueId] = useState<string | null>(null);
  const [playOpp, setPlayOpp] = useState<ArbOpportunity | null>(null);

  const [scanning, setScanning] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [agentTrade, setAgentTrade] = useState<AgentTrade | null>(null);
  const tradeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pnl = trades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);

  // One live edge per active venue pair (best net edge), drawn book-to-book in the arena.
  const edges = useMemo<BookEdge[]>(() => {
    const map = new Map<string, BookEdge>();
    for (const o of opportunities) {
      const vs = [...new Set(o.legs.map((l) => l.venueId))].sort();
      if (vs.length < 2) continue;
      const key = vs.join("+");
      const prev = map.get(key);
      if (!prev || o.netEdge > prev.netEdge) map.set(key, { a: vs[0], b: vs[1], netEdge: o.netEdge });
    }
    return [...map.values()];
  }, [opportunities]);

  // Live-data path (enabled once Phase-2 routes are wired). No-op while USE_MOCK.
  useEffect(() => {
    if (USE_MOCK) return;
    const date = todayDateStr();
    (async () => {
      try {
        const [v, a, o, tr, lg, rk] = await Promise.all([
          fetch("/api/arbitrage/venues").then((r) => r.json()),
          fetch("/api/arbitrage/agents").then((r) => r.json()),
          fetch(`/api/arbitrage/opportunities?date=${date}`).then((r) => r.json()),
          fetch(`/api/arbitrage/trades?date=${date}`).then((r) => r.json()),
          fetch(`/api/arbitrage/logs?date=${date}`).then((r) => r.json()),
          fetch("/api/arbitrage/risk").then((r) => r.json()),
        ]);
        if (v?.venues?.length) setVenues(v.venues);
        if (a?.agents?.[0]) setAgent(a.agents[0]);
        if (o?.opportunities) setOpportunities(o.opportunities);
        if (tr?.trades) setTrades(tr.trades);
        if (lg?.logs) setLogs(lg.logs);
        if (rk?.risk) setRisk(rk.risk);
      } catch (e) {
        console.error("[arbitrage] initial load failed:", e);
      }
    })();
  }, []);

  // Phase 3: pull live normalized markets (Kalshi + Polymarket game totals). Runs
  // regardless of USE_MOCK — real market data flows into the Venue drawer + Arena
  // counts while opportunities/trades/logs stay on fixtures until Phase 5. If the
  // ingestion yields nothing (e.g. no Kalshi creds + Polymarket offseason), the
  // mock markets remain so the UI never goes blank.
  useEffect(() => {
    const date = todayDateStr();
    let cancelled = false;
    let polls = 0;

    function applyMarkets(list: NormalizedMarket[], counts: Record<string, number>) {
      if (cancelled || list.length === 0) return;
      setMarkets(list);
      setMarketsLive(true);
      const now = new Date().toISOString();
      setVenues((prev) =>
        prev.map((v) =>
          counts[v.id] != null
            ? { ...v, cachedTickers: counts[v.id], activeEdges: counts[v.id], freshness: "live", status: v.status === "credential_needed" ? v.status : "connected", lastUpdate: now }
            : v
        )
      );
      // Run the matching engine over the freshly ingested markets (Phase 4).
      fetch(`/api/arbitrage/match-map?date=${date}`)
        .then((r) => r.json())
        .then((mm) => {
          if (!cancelled && mm?.stats) setMatchMap({ matched: mm.matched, rejects: mm.rejects, stats: mm.stats });
        })
        .catch(() => null);

      // Detect real arb opportunities (Phase 5). Replaces the mock list when live.
      fetch(`/api/arbitrage/opportunities?date=${date}`)
        .then((r) => r.json())
        .then((op) => {
          if (cancelled || !Array.isArray(op?.opportunities)) return;
          setOpportunities(op.opportunities);
          setWatch(Array.isArray(op.watch) ? op.watch : []);
          setOppsLive(true);
          const edgeCounts: Record<string, number> = {};
          for (const o of op.opportunities as ArbOpportunity[]) {
            for (const leg of o.legs) edgeCounts[leg.venueId] = (edgeCounts[leg.venueId] ?? 0) + 1;
          }
          setVenues((prev) => prev.map((v) => (edgeCounts[v.id] != null ? { ...v, activeEdges: edgeCounts[v.id] } : { ...v, activeEdges: 0 })));
        })
        .catch(() => null);
    }

    async function poll(): Promise<void> {
      if (cancelled) return;
      const res = await fetch(`/api/arbitrage/markets?date=${date}`).then((r) => r.json()).catch(() => null);
      if (!res) return;
      if (res.markets?.length) {
        applyMarkets(res.markets, res.venueCounts ?? {});
        return;
      }
      if (res.running && polls < 15) {
        polls += 1;
        setTimeout(poll, 2000);
      }
    }

    (async () => {
      const first = await fetch(`/api/arbitrage/markets?date=${date}`).then((r) => r.json()).catch(() => null);
      if (cancelled) return;
      if (first?.markets?.length) {
        applyMarkets(first.markets, first.venueCounts ?? {});
        return;
      }
      // Nothing cached yet — trigger ingestion, then poll for results.
      await fetch("/api/arbitrage/markets/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, password: "123" }),
      }).catch(() => null);
      if (!cancelled) setTimeout(poll, 2000);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateVenue = useCallback((id: string, partial: Partial<Venue>) => {
    setVenues((prev) => prev.map((v) => (v.id === id ? { ...v, ...partial } : v)));
    if (!USE_MOCK) {
      fetch("/api/arbitrage/venues", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...partial }),
      }).catch(console.error);
    }
  }, []);

  const updateAgent = useCallback((partial: Partial<Agent>) => {
    setAgent((prev) => ({ ...prev, ...partial }));
    if (!USE_MOCK) {
      fetch("/api/arbitrage/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: agent.id, ...partial }),
      }).catch(console.error);
    }
  }, [agent.id]);

  const toggleKill = useCallback((v: boolean) => {
    setKillSwitch(v);
    setRisk((prev) => ({ ...prev, killSwitch: v }));
    if (v) setScanning(false);
  }, []);

  // Pull real paper positions + logs written by the execution pipeline. First run
  // auto-settlement so any finished games close out and land in realized P&L.
  const refreshPortfolio = useCallback(async () => {
    await fetch("/api/arbitrage/settle", { method: "POST" }).catch(() => null);
    // Load all positions/logs (across dates) so multi-day open positions show + settle.
    const [tr, lg] = await Promise.all([
      fetch(`/api/arbitrage/trades`).then((r) => r.json()).catch(() => null),
      fetch(`/api/arbitrage/logs`).then((r) => r.json()).catch(() => null),
    ]);
    if (Array.isArray(tr?.trades) && tr.trades.length) {
      setTrades(tr.trades);
      setPortfolioLive(true);
    }
    if (Array.isArray(lg?.logs) && lg.logs.length) setLogs(lg.logs);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Auto-settle finished games before loading positions.
      await fetch("/api/arbitrage/settle", { method: "POST" }).catch(() => null);
      const [tr, lg] = await Promise.all([
        fetch(`/api/arbitrage/trades`).then((r) => r.json()).catch(() => null),
        fetch(`/api/arbitrage/logs`).then((r) => r.json()).catch(() => null),
      ]);
      if (cancelled) return;
      if (Array.isArray(tr?.trades) && tr.trades.length) {
        setTrades(tr.trades);
        setPortfolioLive(true);
      }
      if (Array.isArray(lg?.logs) && lg.logs.length) setLogs(lg.logs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Paper "Play" — animate the agent sliding to leg A + edge to leg B, run the full
  // execution pipeline server-side, then mark the agent ✓/✗ by the real result and
  // refresh the Portfolio + Arb Log.
  const playOpportunity = useCallback(
    async (opp: ArbOpportunity) => {
      const legA = opp.legs[0]?.venueId ?? "kalshi";
      const legB = opp.legs[1]?.venueId ?? "polymarket";
      if (tradeTimer.current) clearTimeout(tradeTimer.current);
      setAgentTrade({ legA, legB, status: "pending" });

      let ok = false;
      try {
        const res = await fetch("/api/arbitrage/trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ opportunityId: opp.id, date: todayDateStr(), mode: "paper" }),
        }).then((r) => r.json());
        ok = res?.result === "executed" || res?.result === "partial";
      } catch (e) {
        console.error(e);
      }

      setAgentTrade({ legA, legB, status: ok ? "success" : "fail" });
      await refreshPortfolio();
      tradeTimer.current = setTimeout(() => setAgentTrade(null), 2800);
    },
    [refreshPortfolio]
  );

  useEffect(() => () => {
    if (tradeTimer.current) clearTimeout(tradeTimer.current);
  }, []);

  const settleTrade = useCallback(
    async (trade: Trade) => {
      await fetch("/api/arbitrage/trades", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: trade.id, date: trade.date, status: "settled" }),
      }).catch(console.error);
      await refreshPortfolio();
    },
    [refreshPortfolio]
  );

  // Re-run the scan: re-ingest fresh quotes, then re-derive match map + opportunities
  // + the main-line watch board. Lets the user refresh the live prices on demand.
  const refreshScan = useCallback(async () => {
    const date = todayDateStr();
    setRefreshing(true);
    try {
      await fetch("/api/arbitrage/markets/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, password: "123" }),
      }).catch(() => null);

      // Poll until ingestion settles, then pull derived data.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const m = await fetch(`/api/arbitrage/markets?date=${date}`).then((r) => r.json()).catch(() => null);
        if (m && !m.running && m.markets?.length) break;
      }
      const [mm, op] = await Promise.all([
        fetch(`/api/arbitrage/match-map?date=${date}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/arbitrage/opportunities?date=${date}`).then((r) => r.json()).catch(() => null),
      ]);
      if (mm?.stats) setMatchMap({ matched: mm.matched, rejects: mm.rejects, stats: mm.stats });
      if (Array.isArray(op?.opportunities)) {
        setOpportunities(op.opportunities);
        setWatch(Array.isArray(op.watch) ? op.watch : []);
        setOppsLive(true);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Auto-fill: when the agent's auto-trade is on and scanning is live, run the paper
  // pipeline for each qualifying opportunity once (dedup via a fired-set), sequentially
  // so the arena animation plays one at a time. Kill switch / Stop halts it.
  const autoFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!agent.autoTrade || !scanning || killSwitch) return;
    const pending = opportunities.filter((o) => !autoFiredRef.current.has(o.id));
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const opp of pending) {
        if (cancelled) break;
        autoFiredRef.current.add(opp.id);
        await playOpportunity(opp);
        await new Promise((r) => setTimeout(r, 800));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opportunities, agent.autoTrade, scanning, killSwitch, playOpportunity]);

  // Auto-scan: while Scanning is on, periodically re-ingest fresh quotes and re-run
  // detection so the board (and auto-fill) stays live without manual Refresh. An
  // in-flight guard prevents overlapping scans; Stop / kill switch halts the loop.
  const scanInFlight = useRef(false);
  useEffect(() => {
    if (!scanning || killSwitch) return;
    const id = setInterval(() => {
      if (scanInFlight.current) return;
      scanInFlight.current = true;
      void Promise.all([refreshScan(), refreshPortfolio()]).finally(() => {
        scanInFlight.current = false;
      });
    }, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [scanning, killSwitch, refreshScan, refreshPortfolio]);

  const openVenue = venues.find((v) => v.id === openVenueId) ?? null;

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: "#0b0d12" }}>
      <ClawArbsTopBar
        scanning={scanning}
        soundOn={soundOn}
        agentCount={1}
        pnl={pnl}
        killSwitch={killSwitch}
        autoTrade={agent.autoTrade}
        onToggleScanning={() => !killSwitch && setScanning((s) => !s)}
        onToggleSound={() => setSoundOn((s) => !s)}
        onToggleAuto={() => !killSwitch && updateAgent({ autoTrade: !agent.autoTrade })}
        onOpenPanel={(k) => {
          setPanel(k);
          if (k === "portfolio" || k === "analytics") refreshPortfolio(); // settle finished games on open
        }}
        onOpenAgent={() => setAgentOpen(true)}
        onReset={() => {
          setTrades(MOCK_TRADES);
          setLogs(MOCK_LOGS);
        }}
      />

      <div className="relative flex-1 min-h-0">
        <ArenaCanvas
          venues={venues}
          logs={logs}
          edges={scanning && !killSwitch ? edges : []}
          agentName={agent.name}
          agentTrade={agentTrade}
          marketsLive={marketsLive}
          onSelectVenue={(id) => setOpenVenueId(id)}
        />

        {panel === "arbs" && (
          <ArbsPanel
            opportunities={opportunities}
            trades={trades}
            watch={watch}
            agentName={agent.name}
            live={oppsLive}
            refreshing={refreshing}
            onRefresh={refreshScan}
            onClose={() => setPanel(null)}
            onPlay={(opp) => setPlayOpp(opp)}
          />
        )}
        {panel === "portfolio" && (
          <PortfolioPanel trades={trades} live={portfolioLive} onSettle={settleTrade} onClose={() => setPanel(null)} />
        )}
        {panel === "risk" && (
          <RiskPanel risk={risk} killSwitch={killSwitch} onToggleKill={toggleKill} onClose={() => setPanel(null)} />
        )}
        {panel === "matchmap" && <MatchMapPanel data={matchMap} live={marketsLive} onClose={() => setPanel(null)} />}
        {panel === "log" && <ArbLogPanel logs={logs} live={portfolioLive} onClose={() => setPanel(null)} />}
        {panel === "analytics" && <AnalyticsPanel trades={trades} onClose={() => setPanel(null)} />}

        {agentOpen && (
          <AgentDrawer agent={agent} logs={logs} onChange={updateAgent} onClose={() => setAgentOpen(false)} />
        )}
        {openVenue && (
          <VenueDrawer
            venue={openVenue}
            markets={markets}
            opportunities={opportunities}
            onChange={(partial) => updateVenue(openVenue.id, partial)}
            onClose={() => setOpenVenueId(null)}
          />
        )}
        {playOpp && (
          <PlayModal opp={playOpp} onClose={() => setPlayOpp(null)} onConfirm={playOpportunity} />
        )}
      </div>
    </div>
  );
}
