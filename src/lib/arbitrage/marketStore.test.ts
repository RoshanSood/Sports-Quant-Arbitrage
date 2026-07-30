import { describe, it, expect, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { getMarkets, saveMarkets, flushMarkets } from "./marketStore";
import type { NormalizedMarket } from "@/types/arbitrage";

// A far-future date so this test never collides with real market data.
const TEST_DATE = "29991231";
const FILE = path.join(process.cwd(), "data", "arbitrage", "markets", `${TEST_DATE}.json`);

function market(venue: string): NormalizedMarket {
  return {
    venueId: venue,
    marketId: `${venue}:1:total:8.5:over`,
    sport: "baseball",
    league: "mlb",
    startTime: "2999-12-31",
    teams: ["A", "B"],
    marketType: "total",
    line: 8.5,
    outcome: "over",
    priceCents: 48,
    decimalOdds: 100 / 48,
    impliedProbability: 0.48,
    depth: 10,
    liquidityUsd: 100,
    live: true,
    status: "open",
    lastUpdated: new Date().toISOString(),
  };
}

afterAll(async () => {
  await fs.rm(FILE, { force: true });
});

describe("marketStore debounced persistence", () => {
  it("updates the in-memory cache immediately but debounces the disk write", async () => {
    await fs.rm(FILE, { force: true });
    await saveMarkets(TEST_DATE, [market("kalshi")]);

    // memStore is the immediate source of truth — read reflects the save at once.
    expect((await getMarkets(TEST_DATE)).map((m) => m.venueId)).toEqual(["kalshi"]);
    // ...but the disk file has NOT been written synchronously (debounced).
    await expect(fs.access(FILE)).rejects.toBeTruthy();

    // A later save coalesces; flush forces the latest state to disk.
    await saveMarkets(TEST_DATE, [market("kalshi"), market("polymarket")]);
    await flushMarkets(TEST_DATE);
    const onDisk = JSON.parse(await fs.readFile(FILE, "utf-8")) as NormalizedMarket[];
    expect(onDisk.map((m) => m.venueId)).toEqual(["kalshi", "polymarket"]);
  });
});
