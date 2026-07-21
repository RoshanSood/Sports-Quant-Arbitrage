// Pure arbitrage math. No I/O — unit-testable. Prices are in cents (0-100) unless
// a name says otherwise. See manual §9 (Arbitrage Math) and §12 (Sizing).

import type { ArbLeg, SizingMethod, StakePlan, VenueId } from "@/types/arbitrage";

// ── Price / probability conversions ──────────────────────────────────────────

export function centsToDollars(cents: number): number {
  return round(cents / 100, 4);
}

export function dollarsToCents(dollars: number): number {
  return round(dollars * 100, 4);
}

// Implied probability of a YES/side at a cents price (47¢ → 0.47).
export function impliedProbFromCents(priceCents: number): number {
  return round(priceCents / 100, 4);
}

// Decimal odds from a cents price (47¢ → 100/47 ≈ 2.128).
export function decimalOddsFromCents(priceCents: number): number {
  if (priceCents <= 0) return 0;
  return round(100 / priceCents, 4);
}

// ── Binary two-leg edge ───────────────────────────────────────────────────────

// total_cost = yes_cents + no_cents (manual §9)
export function totalCostCents(legCents: number[]): number {
  return round(
    legCents.reduce((s, c) => s + c, 0),
    4
  );
}

// gross_edge = (100 - total_cost) / total_cost
export function grossEdge(totalCost: number): number {
  if (totalCost <= 0) return 0;
  return round((100 - totalCost) / totalCost, 6);
}

// net_edge = gross_edge - fees - expected_slippage
// feeFraction + slippageFraction are expressed as fractions of stake.
export function netEdge(
  gross: number,
  feeFraction: number,
  slippageFraction = 0
): number {
  return round(gross - feeFraction - slippageFraction, 6);
}

// ── Equal-profit sizing (manual §12) ──────────────────────────────────────────
//
// For a two-leg binary arb where each leg pays out $1/contract when it wins,
// buying N_i contracts of leg i at price p_i (dollars) costs N_i * p_i and pays
// N_i on a win. Equal-profit sizing chooses contract counts so the guaranteed
// payout is the same regardless of which leg wins, then scales to the stake cap.
export function equalProfitSizing(
  legs: Pick<ArbLeg, "venueId" | "priceCents">[],
  maxStakeDollars: number,
  totalFeeDollars = 0
): StakePlan {
  const method: SizingMethod = "equal_profit";
  const legSizes: Record<VenueId, number> = {};

  if (legs.length === 0 || maxStakeDollars <= 0) {
    return {
      method,
      totalStake: 0,
      legSizes,
      guaranteedPayout: 0,
      expectedProfit: 0,
      profitPerLeg: 0,
    };
  }

  // Each leg wins when its outcome hits. Guaranteed payout must be equal across
  // outcomes. For a target payout P, contracts_i = P and cost_i = P * price_i.
  // Total cost = P * sum(price_i). Choose P so total cost = maxStake.
  const priceSum = legs.reduce((s, l) => s + centsToDollars(l.priceCents), 0);
  if (priceSum <= 0) {
    return {
      method,
      totalStake: 0,
      legSizes,
      guaranteedPayout: 0,
      expectedProfit: 0,
      profitPerLeg: 0,
    };
  }

  const targetPayout = maxStakeDollars / priceSum; // contracts on each leg
  let totalStake = 0;
  for (const leg of legs) {
    const cost = round(targetPayout * centsToDollars(leg.priceCents), 2);
    // Accumulate so a venue carrying two legs (e.g. a 1X2 arb's home+draw) sums correctly.
    legSizes[leg.venueId] = round((legSizes[leg.venueId] ?? 0) + cost, 2);
    totalStake += cost;
  }
  totalStake = round(totalStake, 2);

  const guaranteedPayout = round(targetPayout, 2);
  const expectedProfit = round(guaranteedPayout - totalStake - totalFeeDollars, 2);
  // With equal-profit sizing the payout is identical whichever leg wins.
  const profitPerLeg = expectedProfit;

  return {
    method,
    totalStake,
    legSizes,
    guaranteedPayout,
    expectedProfit,
    profitPerLeg,
  };
}

// ── util ─────────────────────────────────────────────────────────────────────

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
