// Ingestion job (manual §10, §24). Fetches a SportsGameOdds snapshot, normalizes to
// canonical quotes, materializes grid rows via the consensus engine, and persists
// current rows + append-only history + provider health. Public read of a licensed
// feed with a server-side key — no credentials touch the browser.

import { SportsGameOddsAdapter } from "./providers/sportsGameOdds";
import { normalizeBatch } from "./normalize";
import { materializeRows } from "./materialize";
import { appendHistory, saveHealth, saveRows, setRunning } from "./store";

export type IngestSummary = {
  date: string;
  events: number;
  quotes: number;
  rows: number;
  rejects: number;
  providerConfigured: boolean;
};

export async function ingestProps(date: string): Promise<IngestSummary> {
  const adapter = new SportsGameOddsAdapter();
  if (!adapter.hasKey()) {
    await saveHealth([await adapter.health()]);
    return { date, events: 0, quotes: 0, rows: 0, rejects: 0, providerConfigured: false };
  }

  const batch = await adapter.fetchSnapshot({ leagueId: "MLB" });
  const { quotes, rejects } = normalizeBatch(batch);
  const rows = materializeRows(quotes, Date.now());

  await saveRows(date, rows);
  await appendHistory(date, quotes);

  const health = await adapter.health();
  await saveHealth([{ ...health, activeEvents: batch.events.length }]);

  return {
    date,
    events: batch.events.length,
    quotes: quotes.length,
    rows: rows.length,
    rejects,
    providerConfigured: true,
  };
}

// Fire-and-forget wrapper used by the run route; manages the running flag.
export async function runProps(date: string): Promise<void> {
  setRunning(date, true);
  try {
    const s = await ingestProps(date);
    console.log(
      `[props/ingest] ${date}: ${s.events} events → ${s.quotes} quotes → ${s.rows} rows (${s.rejects} rejected)` +
        (s.providerConfigured ? "" : " [provider key missing]")
    );
  } catch (e) {
    console.error(`[props/ingest] ${date} failed:`, e);
  } finally {
    setRunning(date, false);
  }
}
