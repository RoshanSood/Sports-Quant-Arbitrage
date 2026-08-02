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

// ── Executed-trade economics ──────────────────────────────────────────────────
//
// What a trade ACTUALLY cost/earned, derived from the filled legs (real avg prices,
// filled sizes, per-leg fee in cents) rather than the pre-fill quote. Mirrors the
// detection-stage math in prepareExecution so the portfolio shows the truth of the fill:
//   cost    = Σ (contracts × priceCents)/100          (matches the per-leg $ shown in the UI)
//   payout  = matched contracts (min across legs) × $1 — the guaranteed, hedged quantity;
//             any overage on one leg is naked directional, not part of the locked payout
//   profit  = payout − cost − fees
//   netEdge = profit / cost   (identical to grossEdge − feeFraction; SLIPPAGE_RESERVE is 0)
export function executedEconomics(
  legs: Pick<ArbLeg, "priceCents" | "size" | "feeCents">[]
): { totalCost: number; guaranteedPayout: number; expectedProfit: number; netEdge: number } {
  if (legs.length === 0) return { totalCost: 0, guaranteedPayout: 0, expectedProfit: 0, netEdge: 0 };
  const totalCost = round(
    legs.reduce((s, l) => s + centsToDollars(l.size * l.priceCents), 0),
    2
  );
  const guaranteedPayout = round(Math.min(...legs.map((l) => l.size)), 4);
  const feeDollars = legs.reduce((s, l) => s + (l.feeCents || 0) / 100, 0);
  const expectedProfit = round(guaranteedPayout - totalCost - feeDollars, 2);
  const netEdge = totalCost > 0 ? round(expectedProfit / totalCost, 6) : 0;
  return { totalCost, guaranteedPayout, expectedProfit, netEdge };
}

// ── SX.bet $1 minimum-order sizing ────────────────────────────────────────────
//
// SX.bet rejects taker orders below $1. Equal-profit sizing buys the SAME contract count on
// every leg, so scaling all legs by ONE factor keeps the hedge ratio and the edge% identical
// — it just trades a larger (still fully guaranteed) arb. Given the arb legs, return the
// uniform scale needed for the SX leg to stake >= minStakeUsd (1 = no change: already >= $1,
// no SX leg, or unpriced), plus the total stake at that floor (what the live cap must allow).
export function sxbetMinStakeScale(
  legs: Pick<ArbLeg, "venueId" | "priceCents" | "size">[],
  minStakeUsd = 1
): { scale: number; floorTotalUsd: number } {
  const sx = legs.find((l) => l.venueId.toLowerCase().includes("sx"));
  if (!sx || sx.size <= 0) return { scale: 1, floorTotalUsd: 0 };
  const sxPrice = centsToDollars(sx.priceCents);
  if (sxPrice <= 0 || sxPrice * sx.size >= minStakeUsd) return { scale: 1, floorTotalUsd: 0 };
  // Contracts on every leg for the SX leg to clear the minimum; round UP so 4-dp size
  // rounding downstream can't leave it a hair under $1.
  const floorContracts = Math.ceil((minStakeUsd / sxPrice) * 1e4) / 1e4;
  const scale = floorContracts / sx.size;
  const floorTotalUsd = round(
    legs.reduce((s, l) => s + centsToDollars(l.priceCents) * round(l.size * scale, 4), 0),
    2
  );
  return { scale, floorTotalUsd };
}

// ── util ─────────────────────────────────────────────────────────────────────

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
