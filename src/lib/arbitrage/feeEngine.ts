// Venue-specific fee models (manual §9 "Fee defaults"). Pure functions.
// Wired to real leg data in Phase 3+; defaults centralized here.

import type { ArbLeg, FeeBreakdown, VenueId } from "@/types/arbitrage";
import { centsToDollars } from "./arbMath";

export const KALSHI_FEE_TIER = 0.07; // default 7% tier
export const POLYMARKET_SPORTS_FEE = 0.03; // fee-enabled sports taker rate
export const SXBET_TAKER_FEE = 0; // SX.bet charges no taker commission on fills (configurable)

// Kalshi: fee = tier * P * (1 - P), where P is the contract probability (0-1).
// Returned as a per-contract fee fraction of the $1 notional (i.e. in dollars/contract).
export function kalshiFeePerContract(prob: number, tier = KALSHI_FEE_TIER): number {
  const p = clamp01(prob);
  return round(tier * p * (1 - p), 6);
}

// Polymarket fee-enabled markets use C * rate * p * (1-p), where C is the
// contract count and p is the execution price as a probability. Market-level
// fee metadata remains the authority for whether this estimate applies.
export function polymarketFee(contracts: number, prob: number, rate = POLYMARKET_SPORTS_FEE): number {
  const p = clamp01(prob);
  return round(Math.max(0, contracts) * rate * p * (1 - p), 6);
}

// Compute a per-leg fee breakdown. Contract sizes come from the stake plan; if a
// leg has no size yet (detection stage), fee falls back to the per-unit rate.
export function computeFees(legs: ArbLeg[]): FeeBreakdown[] {
  return legs.map((leg) => {
    const isKalshi = leg.venueId.toLowerCase().includes("kalshi");
    const prob = leg.impliedProbability;
    const contracts = leg.size > 0 ? leg.size : 1;

    if (isKalshi) {
      const perContract = kalshiFeePerContract(prob);
      const feeDollars = round(perContract * contracts, 4);
      return {
        venueId: leg.venueId,
        feeCents: round(feeDollars * 100, 4),
        feeRate: KALSHI_FEE_TIER,
        model: "kalshi_tier" as const,
      };
    }

    const isPoly = leg.venueId.toLowerCase().includes("poly");
    const notional = centsToDollars(leg.priceCents) * contracts;
    if (isPoly) {
      const feeDollars = polymarketFee(contracts, prob);
      return {
        venueId: leg.venueId,
        feeCents: round(feeDollars * 100, 4),
        feeRate: POLYMARKET_SPORTS_FEE,
        model: "polymarket_curve" as const,
      };
    }

    const isSx = leg.venueId.toLowerCase().includes("sx");
    if (isSx) {
      const feeDollars = notional * SXBET_TAKER_FEE;
      return {
        venueId: leg.venueId,
        feeCents: round(feeDollars * 100, 4),
        feeRate: SXBET_TAKER_FEE,
        model: "sxbet_flat" as const,
      };
    }

    // Sportmarket / unknown: placeholder until fee model confirmed.
    return {
      venueId: leg.venueId,
      feeCents: 0,
      feeRate: 0,
      model: "placeholder" as const,
    };
  });
}

// Total fee as a fraction of the total stake — feeds netEdge().
export function feeFractionOfStake(
  fees: FeeBreakdown[],
  legSizes: Record<VenueId, number>
): number {
  const totalFeeDollars = fees.reduce((s, f) => s + f.feeCents / 100, 0);
  const totalStake = Object.values(legSizes).reduce((s, v) => s + v, 0);
  if (totalStake <= 0) return 0;
  return round(totalFeeDollars / totalStake, 6);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
