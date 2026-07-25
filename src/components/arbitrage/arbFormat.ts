// Presentational formatters + badge maps for the arbitrage UI. Numeric helpers are
// re-exported from the pure arbMath module so there's a single source of truth.

import { centsToDollars } from "@/lib/arbitrage/arbMath";
import type { ReasonCode, TradeStatus, VenueStatus } from "@/types/arbitrage";

export { centsToDollars };

type VenueStyle = { color: string; text: string };

const VENUE_DISPLAY: Record<string, { name: string } & VenueStyle> = {
  kalshi: { name: "Kalshi", color: "#3b82f6", text: "#93c5fd" },
  polymarket: { name: "Polymarket", color: "#8b5cf6", text: "#c4b5fd" },
  sxbet: { name: "SX.bet", color: "#a855f7", text: "#d8b4fe" },
  predictfun: { name: "predict.fun", color: "#f472b6", text: "#fbcfe8" },
  cloudbet: { name: "Cloudbet", color: "#16a34a", text: "#86efac" },
  sportmarket: { name: "Sportmarket", color: "#7c3aed", text: "#c4b5fd" },
};

function titleCaseVenueId(venueId: string): string {
  return venueId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function venueDisplayName(venueId: string): string {
  return VENUE_DISPLAY[venueId]?.name ?? titleCaseVenueId(venueId);
}

export function venueStyle(venueId: string): VenueStyle {
  return VENUE_DISPLAY[venueId] ?? { color: "#64748b", text: "#cbd5e1" };
}

export function formatCents(cents: number): string {
  return `${Math.round(cents)}¢`;
}

export function formatDollars(dollars: number): string {
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

export function formatSignedDollars(dollars: number): string {
  const sign = dollars >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

// Edge stored as a fraction (0.0679) → "6.79%"
export function formatEdgePct(fraction: number, dp = 2): string {
  return `${(fraction * 100).toFixed(dp)}%`;
}

export function formatOdds(decimalOdds: number): string {
  return decimalOdds.toFixed(2);
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

const REASON_LABELS: Record<ReasonCode, string> = {
  position_dedup: "Position dedup",
  identity_dedup: "Identity dedup",
  stale_quote: "Stale quote",
  insufficient_depth: "Insufficient depth",
  insufficient_balance: "Insufficient balance",
  edge_below_min: "Edge below min",
  edge_above_max: "Edge above max",
  market_suspended: "Market suspended",
  orderbook_not_ready: "Orderbook not ready",
  hedge_failed: "Hedge failed",
  agent_disabled: "Agent disabled",
  kill_switch: "Kill switch",
  venue_view_only: "Venue view-only",
  exposure_exceeded: "Exposure cap",
  final_refresh_failed: "Final refresh failed",
  live_blocked: "Live blocked",
  naked_position: "Naked position",
};

export function reasonCodeLabel(code: ReasonCode | null): string {
  return code ? REASON_LABELS[code] : "—";
}

// Tailwind-friendly color hints (used inline for badges).
export function venueStatusColor(status: VenueStatus): string {
  switch (status) {
    case "connected": return "#22c55e";
    case "degraded": return "#eab308";
    case "credential_needed": return "#f97316";
    case "disconnected": return "#ef4444";
    case "disabled": return "#6b7280";
  }
}

export function venueStatusLabel(status: VenueStatus): string {
  switch (status) {
    case "connected": return "Connected";
    case "degraded": return "Degraded";
    case "credential_needed": return "Credentials needed";
    case "disconnected": return "Disconnected";
    case "disabled": return "Disabled";
  }
}

export function tradeStatusColor(status: TradeStatus): string {
  switch (status) {
    case "open": return "#3b82f6";
    case "settled": return "#22c55e";
    case "closed": return "#6b7280";
    case "partial": return "#eab308";
    case "naked": return "#f97316";
    case "failed": return "#ef4444";
    case "cancelled": return "#6b7280";
  }
}
