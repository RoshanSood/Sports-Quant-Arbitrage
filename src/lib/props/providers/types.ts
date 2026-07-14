// Provider-neutral adapter boundary (manual §11, §13). The rest of the pipeline
// (normalizer, consensus, materializer, UI) depends only on these shapes, so the
// odds vendor can be swapped without touching matching or rendering. Batching,
// endpoint details, and auth stay INSIDE the adapter.

import type { ProviderHealth } from "@/types/props";

// A single raw quote observation as delivered by a provider, before canonicalization.
export type RawProviderQuote = {
  oddID: string; // "{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}"
  statID: string;
  statEntityID: string; // player id for player props
  periodID: string;
  betTypeID: string;
  sideID: string;
  bookId: string;
  line: number | null; // over/under number
  americanOdds: number | null;
  available: boolean;
  sourceUpdatedAt?: string | null;
};

// One event's worth of raw data: identity + its quotes.
export type RawProviderEvent = {
  eventId: string;
  leagueId: string;
  sportId: string;
  startTime: string | null;
  home: { teamId: string; name: string; abbreviation: string };
  away: { teamId: string; name: string; abbreviation: string };
  players: Record<string, { participantId: string; name: string; team: string; position?: string }>;
  quotes: RawProviderQuote[];
};

export type RawProviderBatch = {
  providerId: string;
  fetchedAt: string;
  latencyMs: number;
  events: RawProviderEvent[];
};

export type ProviderFilters = {
  leagueId: string; // "MLB"
};

export type ProviderCatalogEntry = { bookId: string; name: string };
export type ProviderCatalog = { books: ProviderCatalogEntry[] };

// The interface every odds adapter implements (manual §13).
export interface PropProviderAdapter {
  id: string;
  fetchSnapshot(filters: ProviderFilters): Promise<RawProviderBatch>;
  health(): Promise<ProviderHealth>;
}
