// Two-way cross-book arbitrage math for player props. For a single prop LINE, an
// arb takes the best OVER price at one book and the best UNDER price at another; it
// is a locked profit only when the raw implied probabilities sum below 100%. Uses
// actual posted prices (NOT de-vigged) because the arb is executed at those prices.
//
// Reality check (manual §1): true prop arbs are uncommon (books hold ~4-6%); most
// rows show a positive HOLD (the vig). We still surface the best price per side and
// rank by how close the 2-way market is to a lock.

import type { ArbLegPick, TwoWayArb } from "@/types/props";
import { americanToDecimal, americanToProbability } from "./oddsMath";

export type ArbLegInput = { bookId: string; american: number | null; available: boolean };

function bestLeg(list: ArbLegInput[]): ArbLegPick | null {
  let best: ArbLegPick | null = null;
  for (const q of list) {
    if (q.american == null || !Number.isFinite(q.american)) continue;
    const decimal = americanToDecimal(q.american);
    // Highest decimal = best payout for the bettor on that side.
    if (!best || decimal > best.decimal) {
      best = { bookId: q.bookId, american: q.american, decimal, impliedProb: americanToProbability(q.american), available: q.available };
    }
  }
  return best;
}

export function computeTwoWayArb(overs: ArbLegInput[], unders: ArbLegInput[], line: number): TwoWayArb {
  const over = bestLeg(overs);
  const under = bestLeg(unders);
  if (!over || !under) {
    return { line, over, under, combinedImplied: null, edgePct: null, holdPct: null, isArb: false, stake: null, bothAvailable: false };
  }
  const combinedImplied = over.impliedProb + under.impliedProb;
  const edgePct = Number(((1 - combinedImplied) * 100).toFixed(3));
  const io = 1 / over.decimal;
  const iu = 1 / under.decimal;
  const stake = { overPct: io / (io + iu), underPct: iu / (io + iu) };
  return {
    line,
    over,
    under,
    combinedImplied,
    edgePct,
    holdPct: Number((-edgePct).toFixed(3)),
    isArb: combinedImplied < 1,
    stake,
    bothAvailable: over.available && under.available,
  };
}
