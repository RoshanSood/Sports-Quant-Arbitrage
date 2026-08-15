export type PolymarketV3BuyAmounts = {
  makerAmount: string;
  takerAmount: string;
  submittedContracts: number;
  effectiveLimitPriceCents: number;
};

// ExchangeV3 validates the implied price from the signed amounts. Maker collateral may
// have two decimals, taker shares five, and their ratio must still land exactly on a
// 0.0001-dollar price tick. Two-decimal shares let Kalshi hedge the identical quantity.
// Search the smallest marketable price ceiling first, then the largest size at that price;
// preserving the arb's price is more important than retaining a few extra contracts.
export function polymarketV3BuyAmounts(
  requestedContracts: number,
  limitPriceCents: number
): PolymarketV3BuyAmounts | null {
  const candidates = polymarketV3BuyAmountCandidates(requestedContracts, limitPriceCents);
  return candidates.reduce<PolymarketV3BuyAmounts | null>((best, candidate) => {
    if (!best) return candidate;
    const score = candidate.submittedContracts * (100 - candidate.effectiveLimitPriceCents);
    const bestScore = best.submittedContracts * (100 - best.effectiveLimitPriceCents);
    return score > bestScore + 1e-9 ? candidate : best;
  }, null);
}

export function polymarketV3BuyAmountCandidates(
  requestedContracts: number,
  limitPriceCents: number
): PolymarketV3BuyAmounts[] {
  if (
    !Number.isFinite(requestedContracts) || requestedContracts < 1 ||
    !Number.isFinite(limitPriceCents) || limitPriceCents <= 0 || limitPriceCents >= 100
  ) return [];

  const maximumContractTicks = Math.floor((requestedContracts + 1e-9) * 100);
  const minimumPriceTicks = Math.ceil((limitPriceCents - 1e-9) * 100);
  const candidates: PolymarketV3BuyAmounts[] = [];
  for (let priceTicks = minimumPriceTicks; priceTicks < 10_000; priceTicks += 1) {
    for (let contractTicks = maximumContractTicks; contractTicks >= 100; contractTicks -= 1) {
      const product = contractTicks * priceTicks;
      if (product % 10_000 !== 0) continue;
      const makerCents = product / 10_000;
      candidates.push({
        makerAmount: String(makerCents * 10_000),
        takerAmount: String(contractTicks * 10_000),
        submittedContracts: contractTicks / 100,
        effectiveLimitPriceCents: priceTicks / 100,
      });
      break;
    }
  }
  return candidates;
}
