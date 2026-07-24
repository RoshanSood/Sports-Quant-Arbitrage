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
import { DEFAULT_AGENT, DEFAULT_RISK, DEFAULT_VENUES } from "@/lib/arbitrage/seed";
import ClawArbsTopBar from "./ClawArbsTopBar";
import ArenaCanvas, { type AgentTrade, type BookEdge } from "./ArenaCanvas";
import type { ScoreEvent } from "./ActivityFeed";
import type { GameScore } from "@/lib/espnSports";
import ArbsPanel from "./ArbsPanel";
import PortfolioPanel from "./PortfolioPanel";
import RiskPanel from "./RiskPanel";
import MatchMapPanel from "./MatchMapPanel";
import ArbLogPanel from "./ArbLogPanel";
import AgentDrawer from "./AgentDrawer";
import VenueDrawer from "./VenueDrawer";
import PlayModal from "./PlayModal";
import AnalyticsPanel from "./AnalyticsPanel";
import { allAuthHeaders } from "./venueCreds";

export type PanelKey = "arbs" | "portfolio" | "risk" | "log" | "matchmap" | "analytics";

// Server response from POST /api/arbitrage/trades. `mode` is the effective mode: "live" if
// it fired live, "dry_run" if it was an explicit paper request. A blocked live request
// (`blocked:true`) is reported FAILED with `blockers` â€” it is never downgraded to paper.
export type ExecResponse = {
  result?: string;
  reason?: string;
  mode?: "dry_run" | "live";
  blocked?: boolean;
  blockers?: string[];
  error?: string;
} | null;

// Live-only: the dashboard renders real ingested data (or honest empty/scanning
// states) â€” never mock fixtures. Venues start from the seed so the arena has nodes.
const USE_MOCK = false;

// Floor gap between back-to-back scans (each scan re-ingests all venues; the natural
// pace is however long a scan takes, this just prevents a busy-loop if one returns fast).
const SCAN_MIN_GAP_MS = 150;
const INGEST_POLL_MS = 120;
const AUTO_BATCH_LIMIT = 4;

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export default function ArbitrageClient() {
  const [venues, setVenues] = useState<Venue[]>(DEFAULT_VENUES);
  const [agent, setAgent] = useState<Agent>(DEFAULT_AGENT);
  const [opportunities, setOpportunities] = useState<ArbOpportunity[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<ArbLog[]>([]);
  const [risk, setRisk] = useState<RiskSettings>(DEFAULT_RISK);
  // Live normalized markets (Kalshi + Polymarket + SX.bet), populated by ingestion.
  const [markets, setMarkets] = useState<NormalizedMarket[]>([]);
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
  const autoFiredRef = useRef<Set<string>>(new Set());
  const autoInFlightRef = useRef<Set<string>>(new Set());

  // Live score updates for the games the engine currently maps (Activity â†’ SCORES tab).
  const [scoreFeed, setScoreFeed] = useState<ScoreEvent[]>([]);
  const prevScores = useRef<Map<string, { home: number; away: number; period: number; state: string }>>(new Map());

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

  // Game ids the engine currently maps (marketId = "venue:gameId:type:line:outcome").
  // Kept in a ref so the score poller stays on a stable 20s interval instead of resubscribing
  // every time markets refresh.
  const mappedGameIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    mappedGameIds.current = new Set(markets.map((m) => m.marketId.split(":")[1]).filter(Boolean));
  }, [markets]);

  // Poll ESPN scores for the mapped games; flash a bright-yellow SCORES item when a team
  // scores. The first sighting of a game sets a baseline (no spam) â€” only score CHANGES on
  // a live (in-progress) game emit an event.
  useEffect(() => {
    let cancelled = false;
    const sportTag = (s: string) => (s === "baseball" ? "[MLB]" : s === "basketball" ? "[WNBA]" : s === "soccer" ? "[SOC]" : "[SCORE]");
    const quarterLabel = (p: number) => (p <= 4 ? `Q${p}` : p === 5 ? "OT" : `OT${p - 4}`);
    async function poll() {
      const data = (await fetch("/api/arbitrage/scores").then((r) => r.json()).catch(() => null)) as { scores?: GameScore[] } | null;
      if (cancelled || !data?.scores) return;
      const newItems: ScoreEvent[] = [];
      for (const g of data.scores) {
        if (!mappedGameIds.current.has(g.id)) continue; // only games the engine maps
        const prev = prevScores.current.get(g.id);
        const cur = { home: g.home.score, away: g.away.score, period: g.period, state: g.state };
        prevScores.current.set(g.id, cur);
        if (!prev) continue; // first sighting sets the baseline (no emit)

        const line = `${g.away.abbr} ${cur.away}-${cur.home} ${g.home.abbr}`;
        let text: string | null = null;
        if (g.sport === "basketball") {
          // WNBA: fire only at quarter boundaries + final, not on every basket.
          if (cur.state === "in" && cur.period > prev.period) {
            text = `[WNBA] End of ${quarterLabel(prev.period)} - ${line}`;
          } else if (cur.state === "post" && prev.state !== "post") {
            text = `[WNBA] Final - ${line}`;
          }
        } else if (g.state === "in") {
          // Baseball/soccer: per scoring event (run/goal).
          const awayInc = cur.away > prev.away;
          const homeInc = cur.home > prev.home;
          if (awayInc || homeInc) {
            const scorer = awayInc ? g.away : g.home;
            const delta = awayInc ? cur.away - prev.away : cur.home - prev.home;
            text = `${sportTag(g.sport)} ${scorer.name} scored${delta > 1 ? ` (+${delta})` : ""}! ${line}${g.detail ? ` | ${g.detail}` : ""}`;
          }
        }
        if (!text) continue;
        newItems.push({ id: `score-${g.id}-${cur.away}-${cur.home}-${cur.period}-${Date.now()}`, time: new Date().toISOString(), text });
      }
      if (newItems.length) setScoreFeed((prev) => [...newItems, ...prev].slice(0, 60));
    }
    poll();
    const iv = setInterval(poll, 20000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

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
  // regardless of USE_MOCK â€” real market data flows into the Venue drawer + Arena
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
        setTimeout(poll, 500);
      }
    }

    (async () => {
      const first = await fetch(`/api/arbitrage/markets?date=${date}`).then((r) => r.json()).catch(() => null);
      if (cancelled) return;
      if (first?.markets?.length) {
        applyMarkets(first.markets, first.venueCounts ?? {});
        return;
      }
      // Nothing cached yet â€” the GET above auto-triggers ingestion server-side
      // (no admin password), so just poll for results.
      if (!cancelled) setTimeout(poll, 500);
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

  // Persist risk changes server-side â€” the execution gate reads server risk.json, so a
  // UI-only change (kill switch, live stake cap) must be PATCHed or it won't be enforced.
  const updateRisk = useCallback((partial: Partial<RiskSettings>) => {
    setRisk((prev) => ({ ...prev, ...partial }));
    if (typeof partial.killSwitch === "boolean") setKillSwitch(partial.killSwitch);
    if (!USE_MOCK) {
      fetch("/api/arbitrage/risk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      }).catch(console.error);
    }
  }, []);

  const toggleKill = useCallback((v: boolean) => {
    updateRisk({ killSwitch: v });
    if (v) setScanning(false);
  }, [updateRisk]);

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

  // Execute an opportunity â€” animate the agent sliding to leg A + edge to leg B, run the
  // full pipeline server-side, mark the agent âœ“/âœ— by the real result, refresh Portfolio +
  // Arb Log. `mode:"live"` forwards venue creds; the server
  // still runs it through the execution gate and blocks it if any switch fails.
  const executeOpportunity = useCallback(
    async (opp: ArbOpportunity, mode: "paper" | "live", options: { refreshAfter?: boolean } = {}): Promise<ExecResponse> => {
      const refreshAfter = options.refreshAfter ?? true;
      const legA = opp.legs[0]?.venueId ?? "kalshi";
      const legB = opp.legs[1]?.venueId ?? "polymarket";
      if (tradeTimer.current) clearTimeout(tradeTimer.current);
      setAgentTrade({ legA, legB, status: "pending" });

      let res: ExecResponse = null;
      try {
        // Live: forward the venue creds entered in the UI (localStorage â†’ headers). The
        // server uses them transiently and never persists them; env is the fallback.
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (mode === "live") Object.assign(headers, allAuthHeaders());
        res = await fetch("/api/arbitrage/trades", {
          method: "POST",
          headers,
          body: JSON.stringify({ opportunityId: opp.id, date: todayDateStr(), mode }),
        }).then((r) => r.json());
      } catch (e) {
        console.error(e);
      }

      const ok = res?.result === "executed" || res?.result === "partial";
      setAgentTrade({ legA, legB, status: ok ? "success" : "fail" });
      if (refreshAfter) await refreshPortfolio();
      tradeTimer.current = setTimeout(() => setAgentTrade(null), 2800);
      return res;
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

  const fireAutoBatch = useCallback(
    async (nextOpps: ArbOpportunity[]) => {
      if (!agent.autoTrade || !scanning || killSwitch) return;
      const batch = nextOpps
        .filter((o) => !autoFiredRef.current.has(o.id) && !autoInFlightRef.current.has(o.id))
        .slice(0, AUTO_BATCH_LIMIT);
      if (batch.length === 0) return;

      for (const opp of batch) {
        autoFiredRef.current.add(opp.id);
        autoInFlightRef.current.add(opp.id);
      }

      const mode = agent.live ? "live" : "paper";
      await Promise.allSettled(batch.map((opp) => executeOpportunity(opp, mode, { refreshAfter: false })));
      for (const opp of batch) autoInFlightRef.current.delete(opp.id);
      await refreshPortfolio();
    },
    [agent.autoTrade, agent.live, scanning, killSwitch, executeOpportunity, refreshPortfolio]
  );

  // Re-run the scan: re-ingest fresh quotes, then re-derive match map + opportunities
  // + the main-line watch board. Lets the user refresh the live prices on demand.
  const refreshScan = useCallback(async () => {
    const date = todayDateStr();
    setRefreshing(true);
    try {
      // GET with refresh=1 re-triggers ingestion server-side (no admin password).
      await fetch(`/api/arbitrage/markets?date=${date}&refresh=1`).catch(() => null);

      // Poll until ingestion settles, then pull derived data. Tight granularity so a
      // finished scan is picked up fast (the loop below re-scans immediately after).
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, INGEST_POLL_MS));
        const m = await fetch(`/api/arbitrage/markets?date=${date}`).then((r) => r.json()).catch(() => null);
        if (m && !m.running && m.markets?.length) break;
      }
      const [mm, op] = await Promise.all([
        fetch(`/api/arbitrage/match-map?date=${date}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/arbitrage/opportunities?date=${date}`).then((r) => r.json()).catch(() => null),
      ]);
      if (mm?.stats) setMatchMap({ matched: mm.matched, rejects: mm.rejects, stats: mm.stats });
      if (Array.isArray(op?.opportunities)) {
        const nextOpps = op.opportunities as ArbOpportunity[];
        setOpportunities(nextOpps);
        setWatch(Array.isArray(op.watch) ? op.watch : []);
        setOppsLive(true);
        await fireAutoBatch(nextOpps);
      }
    } finally {
      setRefreshing(false);
    }
  }, [fireAutoBatch]);

  // Auto-execute: when auto-trade is on and scanning is live, fire each qualifying
  // opportunity once (dedup via a fired-set). Mode is LIVE when the agent's Live toggle is
  // on; otherwise paper. A live fire still passes the
  // server gate (agent.live, kill switch, stake cap, per-venue creds); if it can't fire it
  // is reported FAILED with the blocking reasons â€” never run as paper. Kill switch / Stop halts it.
  useEffect(() => {
    if (!agent.autoTrade || !scanning || killSwitch) return;
    const pending = opportunities.filter((o) => !autoFiredRef.current.has(o.id) && !autoInFlightRef.current.has(o.id));
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await fireAutoBatch(pending);
    })();
    return () => {
      cancelled = true;
    };
  }, [opportunities, agent.autoTrade, scanning, killSwitch, fireAutoBatch]);

  // Auto-scan: while Scanning is on, re-ingest fresh quotes back-to-back (a new scan
  // starts as soon as the previous finishes) so prices â€” and auto-execution â€” stay as
  // fresh as the venues allow, for catching short-lived arbs. A small floor prevents a
  // busy-loop; Stop / kill switch halts it.
  useEffect(() => {
    if (!scanning || killSwitch) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        await Promise.all([refreshScan(), refreshPortfolio()]);
      } catch {
        // keep looping through transient errors
      }
      if (!cancelled) timer = setTimeout(tick, SCAN_MIN_GAP_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
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
          setTrades([]);
          setLogs([]);
        }}
      />

      <div className="relative flex-1 min-h-0">
        <ArenaCanvas
          venues={venues}
          logs={logs}
          scores={scoreFeed}
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
          <RiskPanel
            risk={risk}
            killSwitch={killSwitch}
            onToggleKill={toggleKill}
            onUpdateRisk={updateRisk}
            agentMaxStake={agent.maxStake}
            onUpdateAgentStake={(maxStake) => updateAgent({ maxStake })}
            agentLive={agent.live}
            autoTrade={agent.autoTrade}
            onClose={() => setPanel(null)}
          />
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
          <PlayModal opp={playOpp} onClose={() => setPlayOpp(null)} onExecute={executeOpportunity} />
        )}
      </div>
    </div>
  );
}
