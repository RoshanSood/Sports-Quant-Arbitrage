import { fetchCloudbetFeedDiagnostics } from "@/lib/cloudbet";
import { fetchPredictFunFeedDiagnostics } from "@/lib/predictFun";
import type { ArbOpportunity, MatchedEvent, NormalizedMarket, VenueId } from "@/types/arbitrage";
import type { ArbReject } from "./arbEngine";
import { dateParamToStorageDate } from "./date";
import { getIngestTimings } from "./marketStore";
import { SPORTS, type ArbGame } from "./sports";

// Distinguishes WHY a venue produced no rows so the scanner can label it clearly instead
// of showing an ambiguous empty cell:
//   ok          — venue produced normalized quotes
//   no_market   — venue was queried successfully but returned nothing for this slate
//   failed      — one or more venue fetches errored (network / venue outage / bad creds)
//   unsupported — venue is not configured for any sport on this slate (never queried)
export type VenueStatus = "ok" | "no_market" | "failed" | "unsupported";

export type VenueDiagnostic = {
  venueId: VenueId;
  fetched: number | null;
  matchedDate: number | null;
  priced: number | null;
  normalized: number;
  matched: number;
  opportunities: number;
  arbRejects: number;
  // Slowest venue fetch this ingest (ms), how many of its fetches errored, and the age of
  // the oldest quote it currently has cached — the per-venue health the scanner surfaces.
  fetchMs: number | null;
  fetchErrors: number;
  staleQuoteAgeMs: number | null;
  status: VenueStatus;
  notes: string[];
};

const VENUES = ["kalshi", "polymarket", "sxbet", "predictfun", "cloudbet"] as const;

function blank(): Record<string, VenueDiagnostic> {
  return Object.fromEntries(
    VENUES.map((venueId) => [
      venueId,
      {
        venueId,
        fetched: null,
        matchedDate: null,
        priced: null,
        normalized: 0,
        matched: 0,
        opportunities: 0,
        arbRejects: 0,
        fetchMs: null,
        fetchErrors: 0,
        staleQuoteAgeMs: null,
        status: "unsupported" as VenueStatus,
        notes: [],
      },
    ])
  );
}

export async function buildVenueDiagnostics(
  date: string,
  markets: NormalizedMarket[],
  matched: MatchedEvent[],
  opportunities: ArbOpportunity[],
  arbRejects: ArbReject[]
): Promise<VenueDiagnostic[]> {
  const out = blank();

  for (const market of markets) {
    const row = out[market.venueId] ?? (out[market.venueId] = { ...blank().kalshi, venueId: market.venueId });
    row.normalized += 1;
  }
  for (const ev of matched) {
    for (const venueId of ev.venues) {
      const row = out[venueId] ?? (out[venueId] = { ...blank().kalshi, venueId });
      row.matched += 1;
    }
  }
  for (const opp of opportunities) {
    for (const venueId of new Set(opp.legs.map((l) => l.venueId))) {
      const row = out[venueId] ?? (out[venueId] = { ...blank().kalshi, venueId });
      row.opportunities += 1;
    }
  }

  const venuesByEvent = new Map<string, Set<string>>();
  for (const ev of matched) venuesByEvent.set(ev.eventKey, new Set(ev.venues));
  for (const reject of arbRejects) {
    for (const venueId of venuesByEvent.get(reject.eventKey) ?? []) {
      const row = out[venueId] ?? (out[venueId] = { ...blank().kalshi, venueId });
      row.arbRejects += 1;
    }
  }

  // Per-venue fetch health from the most recent ingest + oldest cached quote age.
  const timings = getIngestTimings(date);
  const queried = new Set<string>();
  const now = Date.now();
  for (const t of timings) {
    const row = out[t.venueId] ?? (out[t.venueId] = { ...blank().kalshi, venueId: t.venueId });
    queried.add(t.venueId);
    row.fetchMs = Math.max(row.fetchMs ?? 0, t.durationMs);
    if (!t.ok) row.fetchErrors += 1;
  }
  for (const market of markets) {
    const row = out[market.venueId];
    if (!row) continue;
    const age = now - Date.parse(market.lastUpdated);
    if (Number.isFinite(age)) row.staleQuoteAgeMs = Math.max(row.staleQuoteAgeMs ?? 0, age);
  }

  await attachFeedCounts(date, out);
  for (const row of Object.values(out)) {
    // Classify unambiguously: unsupported (never queried) vs failed (fetch errored) vs
    // no_market (queried, empty) vs ok (produced quotes).
    if (row.normalized > 0) row.status = "ok";
    else if (row.fetchErrors > 0) row.status = "failed";
    else if (queried.has(row.venueId) || row.fetched != null) row.status = "no_market";
    else row.status = "unsupported";

    if (row.venueId === "predictfun") row.notes.push("MLB moneyline only; old same-team markets are date-filtered before matching.");
    if (row.venueId === "cloudbet") row.notes.push("Moneyline, MLB totals, and MLB run-line where selections are enabled; live markets may suspend between plays.");
    if (row.status === "unsupported") row.notes.push("Not configured for any sport on this slate — venue was not queried.");
    else if (row.status === "failed") row.notes.push(`${row.fetchErrors} venue fetch(es) errored — outage/timeout or missing read credentials (distinct from 'no market').`);
    else if (row.status === "no_market") row.notes.push("Venue queried successfully but returned no market for this slate/date.");
    else if (row.matched === 0) row.notes.push("Rows normalized, but no cross-venue event/line match survived.");
    else if (row.opportunities === 0) row.notes.push("Matched rows existed, but no net arb passed edge/depth filters.");
  }

  return Object.values(out).sort((a, b) => VENUES.indexOf(a.venueId as (typeof VENUES)[number]) - VENUES.indexOf(b.venueId as (typeof VENUES)[number]));
}

async function attachFeedCounts(date: string, out: Record<string, VenueDiagnostic>): Promise<void> {
  const storageDate = dateParamToStorageDate(date);
  const gamesByLeague = new Map<string, ArbGame[]>();
  await Promise.all(
    SPORTS.map(async (cfg) => {
      try {
        gamesByLeague.set(cfg.league, await cfg.fetchGames(storageDate));
      } catch {
        gamesByLeague.set(cfg.league, []);
      }
    })
  );

  // predict.fun (single MLB read) and every CloudBet-carrying sport were fetched
  // SEQUENTIALLY, making this endpoint ~7s. Run them all CONCURRENTLY instead.
  const mlb = gamesByLeague.get("mlb") ?? [];
  const cbConfigs = SPORTS.filter((s) => s.cloudbet);
  const [pf, cbDiags] = await Promise.all([
    out.predictfun
      ? fetchPredictFunFeedDiagnostics(mlb).catch(() => ({ fetched: 0, matchedDate: 0, priced: 0 }))
      : Promise.resolve(null),
    Promise.all(
      cbConfigs.map((cfg) =>
        fetchCloudbetFeedDiagnostics(gamesByLeague.get(cfg.league) ?? [], cfg.cloudbet!).catch(() => ({ fetched: 0, matchedDate: 0, priced: 0 }))
      )
    ),
  ]);

  if (out.predictfun && pf) Object.assign(out.predictfun, pf);
  if (out.cloudbet) {
    Object.assign(out.cloudbet, {
      fetched: cbDiags.reduce((s, d) => s + d.fetched, 0),
      matchedDate: cbDiags.reduce((s, d) => s + d.matchedDate, 0),
      priced: cbDiags.reduce((s, d) => s + d.priced, 0),
    });
  }
}
