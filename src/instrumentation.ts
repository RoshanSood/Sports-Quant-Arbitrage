// Runs once when the Next.js server starts (Node.js runtime only).
// Handles two things:
//   1. On startup: run value plays for today if no cache exists yet.
//   2. Daily at 8 AM UTC (midnight PST): run value plays for the new day.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getCached, isRunning } = await import("@/lib/valuePlaysCache");
  const { runValuePlaysForDate } = await import("@/lib/valuePlaysRunner");

  function todayStr(): string {
    const d = new Date();
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

  // 1. Run immediately on startup if today has no cache
  runIfMissing(todayStr()).catch(console.error);

  // 2. Schedule daily at 08:00 UTC (midnight PST / 1 AM PDT)
  const cron = (await import("node-cron")).default;
  cron.schedule("0 8 * * *", () => {
    const date = todayStr();
    console.log(`[scheduler] Daily run for ${date}`);
    runIfMissing(date).catch(console.error);
  });
}
