// Venue-specific fee models (manual §9 "Fee defaults"). Pure functions.
// Wired to real leg data in Phase 3+; defaults centralized here.

import type { ArbLeg, FeeBreakdown, VenueId } from "@/types/arbitrage";
import { centsToDollars } from "./arbMath";

export const KALSHI_FEE_TIER = 0.07; // default 7% tier
export const POLYMARKET_SPORTS_FEE = 0.03;
export const SXBET_TAKER_FEE = 0; // SX.bet charges no taker commission on fills (configurable)

// Kalshi: fee = tier * P * (1 - P), where P is the contract probability (0-1).
// Returned as a per-contract fee fraction of the $1 notional (i.e. in dollars/contract).
export function kalshiFeePerContract(prob: number, tier = KALSHI_FEE_TIER): number {
  const p = clamp01(prob);
  return round(tier * p * (1 - p), 6);
}

// The published fee schedule rounds an order's aggregate fee upward. A whole-cent
// ceiling is conservative across Kalshi's fill-level rounding/rebate mechanics.
export function kalshiFee(contracts: number, probability: number, tier = KALSHI_FEE_TIER): number {
  const raw = Math.max(0, contracts) * kalshiFeePerContract(probability, tier);
  if (raw <= 0) return 0;
  return Math.ceil((raw - Number.EPSILON) * 100) / 100;
}

// Polymarket charges takers per share using feeRate * p * (1-p).
export function polymarketFee(contracts: number, probability: number, rate = POLYMARKET_SPORTS_FEE): number {
  const p = clamp01(probability);
  return round(Math.max(0, contracts) * rate * p * (1 - p), 5);
}

// Compute a per-leg fee breakdown from the actual planned contract count.
export function computeFees(legs: ArbLeg[]): FeeBreakdown[] {
  return legs.map((leg) => {
    const isKalshi = leg.venueId.toLowerCase().includes("kalshi");
    const prob = leg.impliedProbability;
    const contracts = Math.max(0, leg.size);

    if (isKalshi) {
      const feeDollars = kalshiFee(contracts, prob);
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
      // Gamma exposes the fee curve rate per market; use the documented sports
      // category rate only when the market-specific value is unavailable.
      const feeRate = leg.feeRate ?? POLYMARKET_SPORTS_FEE;
      const feeDollars = polymarketFee(contracts, prob, feeRate);
      return {
        venueId: leg.venueId,
        feeCents: round(feeDollars * 100, 4),
        feeRate,
        model: "polymarket_sports" as const,
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
