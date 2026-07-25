import type { Agent, NormalizedMarket, Venue } from "@/types/arbitrage";

export function enabledVenueIds(venues: Venue[]): Set<string> {
  return new Set(venues.filter((v) => v.enabled).map((v) => v.id));
}

export function filterMarketsToEnabledVenues(markets: NormalizedMarket[], venues: Venue[]): NormalizedMarket[] {
  const enabled = enabledVenueIds(venues);
  return markets.filter((m) => enabled.has(m.venueId));
}

export function filterMarketsForAgent(markets: NormalizedMarket[], venues: Venue[], agent: Agent): NormalizedMarket[] {
  const enabled = enabledVenueIds(venues);
  const allowed = new Set(agent.venues);
  return markets.filter((m) => enabled.has(m.venueId) && allowed.has(m.venueId));
}
