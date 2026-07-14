// SportsGameOdds adapter (manual §12). Server-side ONLY — the API key is read from
// process.env.SPORTSGAMEODDS_KEY and never reaches the browser or logs. One v2
// /events call returns event metadata + an odds map keyed by oddID with a
// byBookmaker breakdown. We flatten it into provider-neutral RawProviderBatch.
//
// oddID format: {statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}
// Docs: https://sportsgameodds.com/docs/data-types/odds

import type { ProviderHealth } from "@/types/props";
import type {
  PropProviderAdapter,
  ProviderFilters,
  RawProviderBatch,
  RawProviderEvent,
  RawProviderQuote,
} from "./types";

const API_BASE = "https://api.sportsgameodds.com/v2";
const MAX_PAGES = 5; // safety cap on cursor pagination

// The provider returns odds as American strings ("+150" / "-110") or numbers.
function parseAmerican(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace("+", ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// Tolerant readers for the loosely-typed event payload (schema-drift resilient).
type Json = Record<string, unknown>;

function teamInfo(team: Json | undefined): { teamId: string; name: string; abbreviation: string } {
  const names = (team?.names as Json) ?? {};
  const teamId = str(team?.teamID) || str(team?.teamId);
  return {
    teamId,
    name: str(names.long) || str(names.medium) || str(names.short) || str(team?.name) || teamId,
    abbreviation: str(names.abbr) || str(names.short) || str(team?.abbreviation) || teamId.slice(0, 3).toUpperCase(),
  };
}

function playerName(p: Json, playerId: string): string {
  const names = (p.names as Json) ?? {};
  const direct = str(names.display) || str(names.long) || str(names.full);
  if (direct) return direct;
  const first = str(names.first) || str(p.firstName);
  const last = str(names.last) || str(p.lastName);
  if (first || last) return `${first} ${last}`.trim();
  // Fallback: prettify the id (LEBRON_JAMES_NBA → Lebron James).
  return playerId
    .replace(/_[A-Z]+$/, "")
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

function normalizeEvent(ev: Json, homeAbbrFallback = "HOME"): RawProviderEvent | null {
  const eventId = str(ev.eventID) || str(ev.eventId);
  if (!eventId) return null;

  const teams = (ev.teams as Json) ?? {};
  const home = teamInfo(teams.home as Json);
  const away = teamInfo(teams.away as Json);
  if (!home.teamId && !away.teamId) home.abbreviation ||= homeAbbrFallback;

  const status = (ev.status as Json) ?? {};
  const startTime = str(status.startsAt) || str(status.startTime) || str(ev.scheduled) || null;

  const playersRaw = (ev.players as Json) ?? {};
  const players: RawProviderEvent["players"] = {};
  for (const [pid, pRaw] of Object.entries(playersRaw)) {
    const p = (pRaw as Json) ?? {};
    const teamId = str(p.teamID) || str(p.teamId);
    const teamAbbr = teamId === home.teamId ? home.abbreviation : teamId === away.teamId ? away.abbreviation : teamId;
    players[pid] = { participantId: pid, name: playerName(p, pid), team: teamAbbr, position: str(p.position) || undefined };
  }

  const oddsMap = (ev.odds as Json) ?? {};
  const quotes: RawProviderQuote[] = [];
  for (const [oddID, oddRaw] of Object.entries(oddsMap)) {
    const odd = (oddRaw as Json) ?? {};
    const parts = oddID.split("-");
    if (parts.length < 5) continue;
    // statID may itself contain hyphens (e.g. batting_hits+runs+rbi has none, but be safe):
    const sideID = parts[parts.length - 1];
    const betTypeID = parts[parts.length - 2];
    const periodID = parts[parts.length - 3];
    const statEntityID = parts[parts.length - 4];
    const statID = parts.slice(0, parts.length - 4).join("-");

    const byBook = (odd.byBookmaker as Json) ?? {};
    for (const [bookId, bmRaw] of Object.entries(byBook)) {
      const bm = (bmRaw as Json) ?? {};
      quotes.push({
        oddID,
        statID,
        statEntityID,
        periodID,
        betTypeID,
        sideID,
        bookId,
        line: parseNum(bm.overUnder) ?? parseNum(bm.spread) ?? parseNum(odd.fairOverUnder),
        americanOdds: parseAmerican(bm.odds),
        available: bm.available !== false,
        sourceUpdatedAt: str(bm.lastUpdatedAt) || str(odd.lastUpdatedAt) || null,
      });
    }
  }

  return {
    eventId,
    leagueId: str(ev.leagueID) || str(ev.leagueId),
    sportId: str(ev.sportID) || str(ev.sportId),
    startTime,
    home,
    away,
    players,
    quotes,
  };
}

async function fetchEventsPage(
  key: string,
  leagueID: string,
  cursor?: string
): Promise<{ events: Json[]; nextCursor?: string }> {
  const url = new URL(`${API_BASE}/events`);
  url.searchParams.set("leagueID", leagueID);
  url.searchParams.set("finalized", "false");
  url.searchParams.set("oddsAvailable", "true");
  url.searchParams.set("includeAltLines", "true");
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url, { headers: { "x-api-key": key }, cache: "no-store" });
  if (!res.ok) throw new Error(`Provider HTTP ${res.status}`);
  const data = (await res.json()) as Json;
  const events = (data.data ?? data.events ?? []) as Json[];
  const nextCursor = (data.nextCursor ?? (data as Json).cursor) as string | undefined;
  return { events, nextCursor };
}

export class SportsGameOddsAdapter implements PropProviderAdapter {
  id = "sportsgameodds";
  private key: string | undefined;
  private lastLatency: number | null = null;
  private lastSuccess: string | null = null;

  constructor(key = process.env.SPORTSGAMEODDS_KEY) {
    this.key = key;
  }

  hasKey(): boolean {
    return !!this.key;
  }

  async fetchSnapshot(filters: ProviderFilters): Promise<RawProviderBatch> {
    if (!this.key) throw new Error("SPORTSGAMEODDS_KEY not configured");
    const started = Date.now();
    const events: RawProviderEvent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { events: raw, nextCursor } = await fetchEventsPage(this.key, filters.leagueId, cursor);
      for (const ev of raw) {
        const norm = normalizeEvent(ev);
        if (norm) events.push(norm);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    this.lastLatency = Date.now() - started;
    this.lastSuccess = new Date().toISOString();
    return { providerId: this.id, fetchedAt: this.lastSuccess, latencyMs: this.lastLatency, events };
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      status: this.key ? (this.lastSuccess ? "healthy" : "degraded") : "down",
      lastSuccessAt: this.lastSuccess,
      latencyMs: this.lastLatency,
      activeEvents: 0,
      message: this.key ? undefined : "SPORTSGAMEODDS_KEY not configured",
    };
  }
}
