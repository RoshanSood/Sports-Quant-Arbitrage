import type { ArbOpportunity, ReasonCode, RiskSettings, Trade } from "@/types/arbitrage";

export type RiskDecision = { reasonCode: ReasonCode; reason: string; details: Record<string, unknown> };

export function checkPortfolioRisk(
  risk: RiskSettings,
  trades: Trade[],
  opportunity: ArbOpportunity
): RiskDecision | null {
  const openTrades = trades.filter((trade) => trade.status === "open" || trade.status === "partial" || trade.status === "naked");
  if (risk.pauseOnNaked && openTrades.some((trade) => trade.status === "naked")) {
    return { reasonCode: "naked_position", reason: "Execution is paused while a naked position is open", details: {} };
  }
  if (openTrades.length >= risk.maxOpenPositions) {
    return { reasonCode: "open_positions_exceeded", reason: `Open positions ${openTrades.length} >= cap ${risk.maxOpenPositions}`, details: { openCount: openTrades.length } };
  }

  const realizedDailyPnl = trades.reduce((sum, trade) => sum + (trade.realizedPnl ?? 0), 0);
  const effectiveDailyPnl = Math.min(realizedDailyPnl, risk.dailyPnl);
  if (effectiveDailyPnl <= -Math.abs(risk.maxDailyLoss)) {
    return { reasonCode: "daily_loss_exceeded", reason: `Daily P&L ${effectiveDailyPnl.toFixed(2)} reached loss cap ${risk.maxDailyLoss}`, details: { realizedDailyPnl, configuredDailyPnl: risk.dailyPnl } };
  }

  // Respect an operator-supplied external exposure when it exceeds local trade files.
  const localOpenExposure = openTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
  const openExposure = Math.max(localOpenExposure, risk.currentExposure);
  if (openExposure + opportunity.stakePlan.totalStake > risk.maxExposure) {
    return { reasonCode: "exposure_exceeded", reason: `Exposure ${(openExposure + opportunity.stakePlan.totalStake).toFixed(2)} > cap ${risk.maxExposure}`, details: { openExposure } };
  }

  for (const venue of new Set(opportunity.legs.map((leg) => leg.venueId))) {
    const cap = risk.perVenueCap[venue];
    if (!(cap > 0)) continue;
    const current = openTrades.flatMap((trade) => trade.legs).filter((leg) => leg.venueId === venue).reduce((sum, leg) => sum + (leg.size * leg.priceCents) / 100, 0);
    const planned = opportunity.stakePlan.legSizes[venue] ?? 0;
    if (current + planned > cap) {
      return { reasonCode: "exposure_exceeded", reason: `${venue} exposure ${(current + planned).toFixed(2)} > cap ${cap}`, details: { venue, current, planned } };
    }
  }
  return null;
}
