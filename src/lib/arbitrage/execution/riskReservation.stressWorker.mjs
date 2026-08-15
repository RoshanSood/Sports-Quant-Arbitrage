import { RiskReservationService } from "./riskReservation.ts";

const [dbFile, ownerId, startAtRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);
await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));

const service = new RiskReservationService(dbFile);
try {
  const result = service.acquire({
    opportunityId: "baseball:mlb:process-a|process-b:2026-08-10T00:00:00.000Z:moneyline:0",
    idempotencyKey: "multiprocess:generation:1",
    quoteGeneration: "multiprocess:generation:1",
    matchKey: "baseball:mlb:process-a|process-b:2026-08-10T00:00:00.000Z",
    date: "20260810",
    ownerId,
    exposureUsd: 6,
    venueExposureUsd: { kalshi: 3, polymarket: 3 },
    maxExposureUsd: 100,
    maxOpenPositionsPerMatch: 1,
    perVenueCapsUsd: {},
    existingOpenPositions: [],
    legs: [
      { venueId: "kalshi", marketId: "k:a", nativeMarketId: "K-A", nativeSide: "yes", outcome: "home", sizeContracts: 6, limitPriceCents: 40 },
      { venueId: "polymarket", marketId: "p:b", nativeSide: "123", outcome: "away", sizeContracts: 6, limitPriceCents: 55 },
    ],
    ttlMs: 15_000,
  });
  process.stdout.write(JSON.stringify(result));
} finally {
  service.close();
}
