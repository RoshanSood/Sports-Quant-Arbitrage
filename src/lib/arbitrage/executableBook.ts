export type AskLevel = { priceCents: number; contracts: number };

export type AskFill = {
  contracts: number;
  averagePriceCents: number;
  worstPriceCents: number;
  availableContracts: number;
  levels: AskLevel[];
};

// Normalize once everywhere that consumes a live ladder. Duplicate prices can arrive in
// incremental feeds, and microscopic positive quantities must not become a fake top ask.
// We retain those quantities, then walk them until a genuinely executable count is reached.
export function normalizeAskLevels(levels: ReadonlyArray<AskLevel>): AskLevel[] {
  const byPrice = new Map<number, number>();
  for (const level of levels) {
    if (
      !Number.isFinite(level.priceCents) ||
      level.priceCents <= 0 ||
      level.priceCents >= 100 ||
      !Number.isFinite(level.contracts) ||
      level.contracts <= 0
    ) continue;
    byPrice.set(level.priceCents, (byPrice.get(level.priceCents) ?? 0) + level.contracts);
  }
  return [...byPrice.entries()]
    .map(([priceCents, contracts]) => ({ priceCents, contracts }))
    .sort((a, b) => a.priceCents - b.priceCents);
}

// `worstPriceCents` is the safe order limit; `averagePriceCents` is the economic cost.
// Asking for one contract walks past floating-point dust such as 4e-13 contracts.
export function fillAskLevels(levels: ReadonlyArray<AskLevel>, contracts: number): AskFill | null {
  if (!Number.isFinite(contracts) || contracts <= 0) return null;
  const normalized = normalizeAskLevels(levels);
  const availableContracts = normalized.reduce((sum, level) => sum + level.contracts, 0);
  if (availableContracts + 1e-9 < contracts) return null;

  let remaining = contracts;
  let costCents = 0;
  let worstPriceCents = 0;
  for (const level of normalized) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, level.contracts);
    if (take <= 0) continue;
    costCents += take * level.priceCents;
    worstPriceCents = level.priceCents;
    remaining -= take;
  }
  if (remaining > 1e-7 || worstPriceCents <= 0) return null;
  return {
    contracts,
    averagePriceCents: costCents / contracts,
    worstPriceCents,
    availableContracts,
    levels: normalized,
  };
}
