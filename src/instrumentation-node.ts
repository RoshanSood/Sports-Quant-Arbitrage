// Node.js-only startup logic, split out of instrumentation.ts so the Edge runtime
// bundle never traces these fs/path/node-cron imports. Loaded via a dynamic import
// that is gated on NEXT_RUNTIME === "nodejs" (see instrumentation.ts), which lets
// the bundler dead-code-eliminate this module from the Edge build.
//
//   1. On startup: run value plays for today if no cache exists yet.
//   2. Daily at 9:57 PM PT: pre-generate the next day's plays.

import { getCached, isRunning } from "@/lib/valuePlaysCache";
import { runValuePlaysForDate } from "@/lib/valuePlaysRunner";
import { polymarketLiveBook } from "@/lib/arbitrage/polymarketLiveBook";
import { polymarketRegion } from "@/lib/polymarketRegion";
import { kalshiLiveBook } from "@/lib/arbitrage/kalshiLiveBook";
import { sxbetLiveBook } from "@/lib/arbitrage/sxbetLiveBook";

function dateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function runIfMissing(date: string) {
  const sources = ["polymarket", "kalshi"] as const;
  for (const source of sources) {
    const cached = await getCached(date, source).catch(() => null);
    if (!cached && !isRunning(date, source)) {
      console.log(`[scheduler] No cache for ${date}/${source} — starting analysis`);
      runValuePlaysForDate(date, source).catch((e) =>
        console.error(`[scheduler] ${source} ${date} failed:`, e)
      );
    }
  }
}

export async function registerNode() {
  // 1. Run immediately on startup if today has no cache
  runIfMissing(dateStr(0)).catch(console.error);

  // Open the Polymarket live-book websocket immediately on server startup (persistent for
  // the life of this process — see polymarketLiveBook.ts) rather than waiting for the first
  // scan cycle. It has nothing to subscribe to until the first ingest populates the token
  // list, but the connection itself (and its reconnect loop) starts right away.
  if (polymarketRegion() !== "us") {
    polymarketLiveBook.connect();
  }
  // No-ops until KALSHI_KEY_ID/KALSHI_PRIVATE_KEY (or per-request UI creds passed later) are
  // configured — isKalshiConfigured() inside connect() gates it.
  kalshiLiveBook.connect();
  // No-op until SX_API_KEY is configured.
  sxbetLiveBook.connect();

  // 2. Schedule daily at 9:57 PM PT — generates next day's plays the night before
  const cron = (await import("node-cron")).default;
  cron.schedule(
    "57 21 * * *",
    () => {
      const date = dateStr(1); // tomorrow
      console.log(`[scheduler] Nightly pre-run for ${date}`);
      runIfMissing(date).catch(console.error);
    },
    { timezone: "America/Los_Angeles" }
  );
}
