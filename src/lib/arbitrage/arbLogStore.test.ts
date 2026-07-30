import { describe, it, expect, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { parseLogFile, appendLog, getLogs } from "./arbLogStore";
import type { ArbLog } from "@/types/arbitrage";

const LIMIT_DATE = "29990103";
const LIMIT_FILE = path.join(process.cwd(), "data", "arbitrage", "logs", `${LIMIT_DATE}.json`);

function log(id: string, time: string): ArbLog {
  return {
    id,
    time,
    pair: "A v B",
    venues: ["kalshi", "polymarket"],
    edge: 0.02,
    mode: "live",
    agent: "kalshi-mlb",
    result: "executed",
    reasonCode: null,
    reason: "ok",
    detailsJson: {},
    date: "20260729",
  };
}

// appendLog now writes append-only JSONL (oldest-first on disk); the reader must return
// NEWEST-FIRST to preserve the original getLogs contract, and still read legacy JSON-array
// files (which were stored newest-first).
describe("parseLogFile format compatibility", () => {
  it("reads JSONL (oldest-first on disk) and returns newest-first", () => {
    const disk = [log("a", "2026-07-29T10:00:00Z"), log("b", "2026-07-29T11:00:00Z")]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n";
    const out = parseLogFile(disk);
    expect(out.map((l) => l.id)).toEqual(["b", "a"]); // newest-first
  });

  it("reads a legacy JSON array (already newest-first) unchanged", () => {
    const legacy = JSON.stringify([log("b", "2026-07-29T11:00:00Z"), log("a", "2026-07-29T10:00:00Z")], null, 2);
    const out = parseLogFile(legacy);
    expect(out.map((l) => l.id)).toEqual(["b", "a"]); // preserved newest-first
  });

  it("ignores blank lines and returns [] for empty input", () => {
    expect(parseLogFile("")).toEqual([]);
    expect(parseLogFile("   \n\n")).toEqual([]);
    const oneWithBlanks = "\n" + JSON.stringify(log("a", "2026-07-29T10:00:00Z")) + "\n\n";
    expect(parseLogFile(oneWithBlanks).map((l) => l.id)).toEqual(["a"]);
  });
});

// The log panel scopes to a date + limit so the client never pulls the whole history
// (the arbitrage page-lag cause). getLogs must cap to the newest `limit` rows, and remain
// exhaustive when no limit is given (the postmortem needs every row for a date).
describe("getLogs date + limit", () => {
  afterAll(async () => {
    await fs.rm(LIMIT_FILE, { force: true });
  });

  it("caps to the newest `limit` rows for a date, and returns all when unbounded", async () => {
    await fs.rm(LIMIT_FILE, { force: true });
    for (let i = 0; i < 10; i++) {
      await appendLog({ ...log(`e${i}`, `2029-01-03T00:00:${String(i).padStart(2, "0")}Z`), date: LIMIT_DATE });
    }
    const capped = await getLogs(LIMIT_DATE, 3);
    expect(capped).toHaveLength(3);
    // Newest-first: e9, e8, e7 (highest timestamps).
    expect(capped.map((l) => l.id)).toEqual(["e9", "e8", "e7"]);

    const all = await getLogs(LIMIT_DATE);
    expect(all).toHaveLength(10);
  });
});
