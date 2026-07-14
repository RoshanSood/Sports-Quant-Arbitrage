// Typed mock fixtures for the Phase-1 UI shell. Numbers are computed with the real
// arbMath/feeEngine helpers so the dashboard is internally consistent. Swapped for
// live API data in later phases (see USE_MOCK in ArbitrageClient).

import type {
  ArbLeg,
  ArbLog,
  ArbOpportunity,
  MatchKey,
  NormalizedMarket,
  Trade,
} from "@/types/arbitrage";
import { DEFAULT_AGENT, DEFAULT_VENUES } from "./seed";
import {
  decimalOddsFromCents,
  equalProfitSizing,
  grossEdge,
  impliedProbFromCents,
  netEdge,
  totalCostCents,
} from "./arbMath";
import { computeFees, feeFractionOfStake } from "./feeEngine";

export const MOCK_VENUES = DEFAULT_VENUES;
export { DEFAULT_AGENT };

// ── Opportunity builder ──────────────────────────────────────────────────────

type LegSpec = {
  venueId: string;
  marketId: string;
  outcome: ArbLeg["outcome"];
  priceCents: number;
  label: string;
};

function buildLeg(spec: LegSpec, size: number): ArbLeg {
  return {
    venueId: spec.venueId,
    marketId: spec.marketId,
    outcome: spec.outcome,
    priceCents: spec.priceCents,
    decimalOdds: decimalOddsFromCents(spec.priceCents),
    impliedProbability: impliedProbFromCents(spec.priceCents),
    size,
    feeCents: 0, // filled below from computeFees
    label: spec.label,
  };
}

function buildOpportunity(
  id: string,
  matchup: string,
  eventKey: string,
  marketType: ArbOpportunity["marketType"],
  line: number | null,
  specs: [LegSpec, LegSpec],
  detectedAt: string,
  status: ArbOpportunity["status"] = "tracked"
): ArbOpportunity {
  const maxStake = DEFAULT_AGENT.maxStake;

  // Provisional legs (size 0) to get a stake plan, then re-size.
  const provisional = specs.map((s) => buildLeg(s, 0));
  const plan = equalProfitSizing(provisional, maxStake);

  // Convert per-venue dollar sizes into contract counts, then finalize legs.
  const legs = specs.map((s) => {
    const dollars = plan.legSizes[s.venueId] ?? 0;
    const contracts = s.priceCents > 0 ? (dollars / (s.priceCents / 100)) : 0;
    return buildLeg(s, Math.round(contracts));
  });

  const fees = computeFees(legs);
  legs.forEach((leg, i) => {
    leg.feeCents = fees[i].feeCents;
  });

  const cost = totalCostCents(legs.map((l) => l.priceCents));
  const gross = grossEdge(cost);
  const feeFrac = feeFractionOfStake(fees, plan.legSizes);
  const net = netEdge(gross, feeFrac, 0.002);

  return {
    id,
    eventKey,
    matchup,
    marketType,
    line,
    legs,
    totalCostCents: cost,
    grossEdge: gross,
    netEdge: net,
    fees,
    depthLimit: Math.min(...legs.map((l) => l.size)) * 4,
    stakePlan: { ...plan, expectedProfit: round(plan.guaranteedPayout - plan.totalStake, 2) },
    quoteFreshness: 800,
    agentId: DEFAULT_AGENT.id,
    status,
    detectedAt,
  };
}

const NOW = "2026-07-07T23:52:00.000Z";

export const MOCK_OPPORTUNITIES: ArbOpportunity[] = [
  buildOpportunity(
    "arb-phi-cin-total",
    "Phillies v Reds",
    "baseball:mlb:phillies:reds:2026-07-07T23:05Z:total:6.5",
    "total",
    6.5,
    [
      { venueId: "kalshi", marketId: "KXMLBTOTAL-PHICIN-U65", outcome: "under", priceCents: 51, label: "NO (under 6.5)" },
      { venueId: "polymarket", marketId: "0xphicin-over-65", outcome: "over", priceCents: 41, label: "over 6.5" },
    ],
    NOW
  ),
  buildOpportunity(
    "arb-phi-cin-ml",
    "Phillies v Reds",
    "baseball:mlb:phillies:reds:2026-07-07T23:05Z:moneyline",
    "moneyline",
    null,
    [
      { venueId: "polymarket", marketId: "0xphicin-ml-phi", outcome: "no", priceCents: 12, label: "NO @ 8.47" },
      { venueId: "kalshi", marketId: "KXMLBGAME-PHICIN-HOME", outcome: "home", priceCents: 84, label: "home @ 1.19" },
    ],
    NOW
  ),
  buildOpportunity(
    "arb-tb-nyy-total",
    "Tampa Bay Rays v New York Yankees",
    "baseball:mlb:rays:yankees:2026-07-07T23:05Z:total:10.5",
    "total",
    10.5,
    [
      { venueId: "kalshi", marketId: "KXMLBTOTAL-TBNYY-U105", outcome: "under", priceCents: 57, label: "NO (under 10.5)" },
      { venueId: "polymarket", marketId: "0xtbnyy-over-105", outcome: "over", priceCents: 39, label: "over 10.5" },
    ],
    NOW
  ),
  buildOpportunity(
    "arb-hou-was-total",
    "Houston v Washington",
    "baseball:mlb:astros:nationals:2026-07-07T23:05Z:total:10.5",
    "total",
    10.5,
    [
      { venueId: "kalshi", marketId: "KXMLBTOTAL-HOUWAS-U105", outcome: "under", priceCents: 55, label: "NO (under 10.5)" },
      { venueId: "polymarket", marketId: "0xhouwas-over-105", outcome: "over", priceCents: 40, label: "over 10.5" },
    ],
    NOW,
    "open"
  ),
];

// ── Trades (portfolio rows) ──────────────────────────────────────────────────

function tradeFromOpp(
  opp: ArbOpportunity,
  status: Trade["status"],
  realizedPnl: number | null,
  clvDrift: number | null,
  openedAt: string
): Trade {
  return {
    id: `trade-${opp.id}`,
    mode: "paper",
    opportunityId: opp.id,
    agentId: opp.agentId,
    matchup: opp.matchup,
    legs: opp.legs,
    orderIds: opp.legs.map((_, i) => `paper-${opp.id}-${i}`),
    fillStatus: status === "failed" ? "failed" : "filled",
    totalCost: opp.stakePlan.totalStake,
    expectedProfit: opp.stakePlan.expectedProfit,
    realizedPnl,
    netEdge: opp.netEdge,
    clvDrift,
    status,
    openedAt,
    closedAt: status === "settled" || status === "closed" ? "2026-07-08T02:10:00.000Z" : null,
    date: "20260707",
  };
}

export const MOCK_TRADES: Trade[] = [
  tradeFromOpp(MOCK_OPPORTUNITIES[0], "open", null, 0.0983, "2026-07-08T00:00:43.000Z"),
  tradeFromOpp(MOCK_OPPORTUNITIES[2], "open", null, 0.282, "2026-07-08T00:00:43.000Z"),
  tradeFromOpp(MOCK_OPPORTUNITIES[1], "settled", 1.19, 0.041, "2026-07-07T22:30:00.000Z"),
];

// ── Normalized markets (venue Live tab) ──────────────────────────────────────

export const MOCK_MARKETS: NormalizedMarket[] = MOCK_OPPORTUNITIES.flatMap((opp) =>
  opp.legs.map((leg) => ({
    venueId: leg.venueId,
    marketId: leg.marketId,
    sport: "baseball" as const,
    league: "mlb",
    startTime: "2026-07-07T23:05:00.000Z",
    teams: opp.matchup.split(" v ") as [string, string],
    marketType: opp.marketType,
    line: opp.line,
    outcome: leg.outcome,
    priceCents: leg.priceCents,
    decimalOdds: leg.decimalOdds,
    impliedProbability: leg.impliedProbability,
    depth: opp.depthLimit,
    liquidityUsd: 100,
    live: true,
    status: "open" as const,
    lastUpdated: NOW,
  }))
);

// ── Match Map ────────────────────────────────────────────────────────────────

export const MOCK_MATCH_KEYS: MatchKey[] = [
  {
    sport: "baseball", league: "mlb", startWindow: "2026-07-07T23:05Z",
    canonicalTeams: ["Athletics", "Tigers"], homeAway: "home_away",
    marketType: "moneyline", line: null, outcomeGroup: "two_way", confidence: 0.98,
  },
  {
    sport: "baseball", league: "mlb", startWindow: "2026-07-07T23:05Z",
    canonicalTeams: ["Braves", "Pirates"], homeAway: "home_away",
    marketType: "moneyline", line: null, outcomeGroup: "two_way", confidence: 0.97,
  },
  {
    sport: "baseball", league: "mlb", startWindow: "2026-07-07T23:05Z",
    canonicalTeams: ["Phillies", "Reds"], homeAway: "home_away",
    marketType: "total", line: 6.5, outcomeGroup: "two_way", confidence: 0.99,
  },
  {
    sport: "baseball", league: "mlb", startWindow: "2026-07-07T23:05Z",
    canonicalTeams: ["Cubs", "Orioles"], homeAway: "home_away",
    marketType: "total", line: 8.5, outcomeGroup: "two_way", confidence: 0.96,
  },
];

// ── Arb Log ──────────────────────────────────────────────────────────────────

export const MOCK_LOGS: ArbLog[] = [
  {
    id: "log-1", time: "2026-07-07T23:52:45.000Z",
    pair: "[CB:kalshi-mlb] Phillies v Reds", venues: ["kalshi", "polymarket"],
    edge: 0.0679, mode: "paper", agent: "kalshi-mlb", result: "executed",
    reasonCode: null, reason: "Both legs filled (paper)",
    detailsJson: { yesCents: 51, noCents: 41, stake: 50, expectedProfit: 4.4 },
    date: "20260707",
  },
  {
    id: "log-2", time: "2026-07-07T23:52:31.000Z",
    pair: "[CB:kalshi-mlb] Athletics v Tigers", venues: ["kalshi", "polymarket"],
    edge: 0.0351, mode: "paper", agent: "kalshi-mlb", result: "halted",
    reasonCode: "identity_dedup", reason: "already tracking same physical match",
    detailsJson: { matchedLabel: "Athletics vs Tigers", existingOpportunity: "arb-oak-det" },
    date: "20260707",
  },
  {
    id: "log-3", time: "2026-07-07T23:52:25.000Z",
    pair: "[CB:kalshi-mlb] Tampa Bay Rays v New York Yankees", venues: ["kalshi", "polymarket"],
    edge: 0.0234, mode: "paper", agent: "kalshi-mlb", result: "halted",
    reasonCode: "position_dedup", reason: "already tracking match+strategy (max=1, open=1)",
    detailsJson: { maxPositions: 1, openPositions: 1 },
    date: "20260707",
  },
  {
    id: "log-4", time: "2026-07-07T23:51:40.000Z",
    pair: "[CB:kalshi-mlb] Philadelphia v Cincinnati", venues: ["kalshi", "polymarket"],
    edge: 0.0323, mode: "paper", agent: "kalshi-mlb", result: "halted",
    reasonCode: "orderbook_not_ready", reason: "kalshi orderbook not streamed yet",
    detailsJson: { venue: "kalshi", marketId: "KXMLBGAME-PHICIN-HOME" },
    date: "20260707",
  },
  {
    id: "log-5", time: "2026-07-07T23:50:23.000Z",
    pair: "[CB:kalshi-mlb] Seattle v Miami", venues: ["kalshi", "polymarket"],
    edge: 0.281, mode: "paper", agent: "kalshi-mlb", result: "halted",
    reasonCode: "edge_above_max", reason: "edge above cap and likely stale or mismatched",
    detailsJson: { edge: 0.281, maxEdge: 0.25 },
    date: "20260707",
  },
];

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
