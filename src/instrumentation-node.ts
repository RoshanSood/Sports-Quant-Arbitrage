// Node.js-only startup logic, split out of instrumentation.ts so the Edge runtime
// bundle never traces these fs/path/node-cron imports. Loaded via a dynamic import
// that is gated on NEXT_RUNTIME === "nodejs" (see instrumentation.ts), which lets
// the bundler dead-code-eliminate this module from the Edge build.
//
//   1. On startup: run value plays for today if no cache exists yet.
//   2. Daily at 9:57 PM PT: pre-generate the next day's plays.

import { getCached, isRunning } from "@/lib/valuePlaysCache";
import { runValuePlaysForDate } from "@/lib/valuePlaysRunner";
import { resumeArbitrageScanner } from "@/lib/arbitrage/scannerWorker";

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
  // The arbitrage scanner is a server-owned worker. It survives dashboard reloads and
  // starts from its persisted enabled state instead of depending on React component state.
  if (
    process.env.NEXT_PHASE !== "phase-production-build"
    && process.env.npm_lifecycle_event !== "build"
    && process.env.ARB_SCANNER_DISABLED !== "1"
  ) {
    resumeArbitrageScanner().catch((e) => console.error("[arbitrage/scanner] startup failed:", e));
  }

  // 1. Run immediately on startup if today has no cache
  runIfMissing(dateStr(0)).catch(console.error);

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
