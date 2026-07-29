import { fetchCloudbetFeedDiagnostics } from "@/lib/cloudbet";
import { fetchPredictFunFeedDiagnostics } from "@/lib/predictFun";
import type { ArbOpportunity, MatchedEvent, NormalizedMarket, VenueId } from "@/types/arbitrage";
import type { ArbReject } from "./arbEngine";
import { SPORTS, type ArbGame } from "./sports";

export type VenueDiagnostic = {
  venueId: VenueId;
  fetched: number | null;
  matchedDate: number | null;
  priced: number | null;
  normalized: number;
  matched: number;
  opportunities: number;
  arbRejects: number;
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

  await attachFeedCounts(date, out);
  for (const row of Object.values(out)) {
    if (row.venueId === "predictfun") row.notes.push("MLB moneyline only; old same-team markets are date-filtered before matching.");
    if (row.venueId === "cloudbet") row.notes.push("Moneyline, MLB totals, and MLB run-line where selections are enabled; live markets may suspend between plays.");
    if (row.normalized === 0 && row.fetched === 0) row.notes.push("No raw feed rows returned, or venue read credentials are missing.");
    else if (row.normalized === 0 && row.fetched != null) row.notes.push("Feed returned rows, but none matched this slate/date with executable prices.");
    else if (row.matched === 0) row.notes.push("Rows normalized, but no cross-venue event/line match survived.");
    else if (row.opportunities === 0) row.notes.push("Matched rows existed, but no net arb passed edge/depth filters.");
  }

  return Object.values(out).sort((a, b) => VENUES.indexOf(a.venueId as (typeof VENUES)[number]) - VENUES.indexOf(b.venueId as (typeof VENUES)[number]));
}

async function attachFeedCounts(date: string, out: Record<string, VenueDiagnostic>): Promise<void> {
  const gamesByLeague = new Map<string, ArbGame[]>();
  await Promise.all(
    SPORTS.map(async (cfg) => {
      try {
        gamesByLeague.set(cfg.league, await cfg.fetchGames(date));
      } catch {
        gamesByLeague.set(cfg.league, []);
      }
    })
  );

  const mlb = gamesByLeague.get("mlb") ?? [];
  if (out.predictfun) {
    const pf = await fetchPredictFunFeedDiagnostics(mlb).catch(() => ({ fetched: 0, matchedDate: 0, priced: 0 }));
    Object.assign(out.predictfun, pf);
  }

  const cb = out.cloudbet;
  if (cb) {
    let fetched = 0;
    let matchedDate = 0;
    let priced = 0;
    for (const cfg of SPORTS.filter((s) => s.cloudbet)) {
      const games = gamesByLeague.get(cfg.league) ?? [];
      const diag = await fetchCloudbetFeedDiagnostics(games, cfg.cloudbet!).catch(() => ({ fetched: 0, matchedDate: 0, priced: 0 }));
      fetched += diag.fetched;
      matchedDate += diag.matchedDate;
      priced += diag.priced;
    }
    Object.assign(cb, { fetched, matchedDate, priced });
  }
}
