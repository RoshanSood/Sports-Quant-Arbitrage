// Default seed data for the arbitrage module. Single source of truth used by the
// JSON stores (seed-on-miss) and referenced by mock data. No secrets — venues are
// created disconnected/credential_needed until the user configures credentials.

import type { Agent, RiskSettings, Venue } from "@/types/arbitrage";

export const DEFAULT_VENUES: Venue[] = [
  {
    id: "kalshi",
    name: "Kalshi",
    abbr: "K",
    type: "prediction_market",
    role: "sharp",
    currency: "USD",
    status: "credential_needed",
    enabled: true,
    viewOnly: false,
    supportsCancel: true,
    supportsPartialFill: true, // FAK optional; FOK default
    isIrreversible: false,
    color: "#3b82f6",
    activeEdges: 0,
    cachedTickers: 0,
    freshness: "unknown",
  },
  {
    id: "polymarket",
    name: "Polymarket",
    abbr: "P",
    type: "prediction_market",
    role: "primary",
    currency: "USDC",
    status: "connected", // public Gamma API needs no credentials
    enabled: true,
    viewOnly: true, // execution stays disabled until a vetted FOK adapter is wired
    supportsCancel: false,
    supportsPartialFill: false,
    isIrreversible: true, // CLOB orders treated as irreversible
    color: "#8b5cf6",
    activeEdges: 0,
    cachedTickers: 0,
    freshness: "unknown",
  },
  {
    id: "sxbet",
    name: "SX.bet",
    abbr: "SX",
    type: "exchange",
    role: "reference",
    currency: "USDC",
    status: "connected", // public read-only order-book feed
    enabled: true,
    viewOnly: true, // read-only: scanned for edges, but no execution yet
    supportsCancel: true,
    supportsPartialFill: true,
    isIrreversible: false,
    color: "#a855f7",
    activeEdges: 0,
    cachedTickers: 0,
    freshness: "unknown",
  },
  {
    id: "sportmarket",
    name: "Sportmarket",
    abbr: "SM",
    type: "sportsbook",
    role: "reference",
    currency: "USD",
    status: "disabled",
    enabled: false,
    viewOnly: true,
    supportsCancel: true,
    supportsPartialFill: false,
    isIrreversible: false,
    color: "#7c3aed",
    activeEdges: 0,
    cachedTickers: 0,
    freshness: "unknown",
  },
];

export const DEFAULT_AGENT: Agent = {
  id: "kalshi-mlb",
  name: "kalshi-mlb",
  strategy: "arbitrage",
  enabled: true,
  paper: true, // paper trading on by default
  live: false, // live execution locked until user enables
  autoTrade: false, // manual Play by default; user opts into hands-off paper fills
  minEdge: 0.005, // 0.5%
  maxEdge: 0.25, // 25%
  sizingMethod: "equal_profit",
  maxStake: 50,
  venues: ["kalshi", "polymarket"],
  // Polling/cache MVP refreshes quotes per ingestion run, not per tick — a 5-minute
  // freshness window fits that cadence. Real-time WebSocket streaming (later phase)
  // would tighten this back to seconds.
  staleQuoteMs: 300000,
};

export const DEFAULT_RISK: RiskSettings = {
  killSwitch: false,
  maxExposure: 10000,
  currentExposure: 0,
  maxDailyLoss: 500,
  dailyPnl: 0,
  maxOpenPositions: 1, // one position per physical match + strategy
  pauseOnNaked: true,
  staleQuoteMs: 300000, // see DEFAULT_AGENT note — fits the polling/cache cadence
  minLiquidityUsd: 20, // filter thin/tail lines with little executable size
  perVenueCap: {},
};
