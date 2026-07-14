// Normalizer (manual §14–§16). Converts a provider-neutral RawProviderBatch into
// canonical prop quotes: resolves the provider statID/periodID to our registry,
// attaches player + event identity, and keeps only over/under player props with a
// numeric line. Unresolved stats/periods are dropped (prefer a missing row over a
// false one, §15). Each quote carries its grouping key so the materializer can
// assemble rows without re-parsing.

import type { EventSummary, PlayerSummary, Side } from "@/types/props";
import { resolveProviderPeriod, resolveProviderStat } from "./statRegistry";
import type { CanonicalPeriod, CanonicalStat } from "@/types/props";
import type { RawProviderBatch } from "./providers/types";

export type PropQuote = {
  quoteId: string;
  canonicalKey: string; // eventId|participantId|statId|periodId — line is NOT part of identity
  stat: CanonicalStat;
  period: CanonicalPeriod;
  player: PlayerSummary;
  event: EventSummary;
  side: Side;
  bookId: string;
  line: number;
  americanOdds: number | null;
  available: boolean;
  observedAt: string;
  sourceUpdatedAt: string | null;
};

export type NormalizeResult = {
  quotes: PropQuote[];
  rejects: number; // count of odds dropped (unresolved stat/period, non-ou, malformed)
};

function sideFrom(sideID: string): Side | null {
  const s = sideID.toLowerCase();
  if (s === "over") return "OVER";
  if (s === "under") return "UNDER";
  return null;
}

export function normalizeBatch(batch: RawProviderBatch): NormalizeResult {
  const quotes: PropQuote[] = [];
  let rejects = 0;
  const observedAt = batch.fetchedAt;

  for (const ev of batch.events) {
    const event: EventSummary = {
      eventId: ev.eventId,
      sport: "baseball",
      league: "mlb",
      homeTeam: ev.home.abbreviation,
      awayTeam: ev.away.abbreviation,
      startTime: ev.startTime ?? new Date().toISOString(),
      matchupLabel: `${ev.away.abbreviation} @ ${ev.home.abbreviation}`,
    };

    for (const q of ev.quotes) {
      if (q.betTypeID.toLowerCase() !== "ou") continue; // player-prop over/under only
      const side = sideFrom(q.sideID);
      if (!side) {
        rejects++;
        continue;
      }
      const stat = resolveProviderStat(q.statID);
      const period = resolveProviderPeriod(q.periodID);
      if (!stat || !period || q.line == null) {
        rejects++;
        continue;
      }
      // Player props only — SGO uses statEntityID all/home/away for team & game-scope
      // totals (e.g. `points-home-game-ou`); skip those (manual §1, §6).
      const entity = q.statEntityID.toLowerCase();
      if (entity === "all" || entity === "home" || entity === "away") {
        rejects++;
        continue;
      }
      const p = ev.players[q.statEntityID];
      const player: PlayerSummary = p
        ? { participantId: p.participantId, name: p.name, team: p.team, position: p.position, headshotUrl: null }
        : { participantId: q.statEntityID, name: q.statEntityID, team: "", headshotUrl: null };

      quotes.push({
        quoteId: `${q.bookId}:${q.oddID}`,
        canonicalKey: `${ev.eventId}|${q.statEntityID}|${stat.id}|${period.id}`,
        stat,
        period,
        player,
        event,
        side,
        bookId: q.bookId,
        line: q.line,
        americanOdds: q.americanOdds,
        available: q.available,
        observedAt,
        sourceUpdatedAt: q.sourceUpdatedAt ?? null,
      });
    }
  }

  return { quotes, rejects };
}
