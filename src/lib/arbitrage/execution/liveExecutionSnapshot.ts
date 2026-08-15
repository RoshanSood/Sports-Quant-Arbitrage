import type { ArbLeg } from "@/types/arbitrage";
import { kalshiLiveBook } from "../kalshiLiveBook";
import { polymarketLiveBook } from "../polymarketLiveBook";
import { normalizeAskLevels } from "../executableBook";

// This is connection verification age, not pipeline latency. A quiet market can have an
// unchanged book for several seconds while its websocket remains healthy and gap-free.
export const LIVE_EXECUTION_SNAPSHOT_FRESH_MS = 15_000;

export type LiveExecutionSnapshotLeg = {
  venueId: string;
  marketId: string;
  nativeMarketId?: string;
  nativeSide?: string;
  sourceUpdatedAt: number;
  levels: ReadonlyArray<Readonly<{ priceCents: number; contracts: number }>>;
};

export type LiveExecutionSnapshot = {
  capturedAt: number;
  oldestAgeMs: number;
  legs: ReadonlyArray<LiveExecutionSnapshotLeg>;
};

export type LiveSnapshotReader = (leg: ArbLeg) => {
  levels: Array<{ priceCents: number; contracts: number }>;
  updatedAt: number;
} | null;

export const currentLiveSnapshotForLeg: LiveSnapshotReader = (leg) => {
  if (leg.venueId === "polymarket" && leg.nativeSide) return polymarketLiveBook.getAskSnapshot(leg.nativeSide);
  if (leg.venueId === "kalshi" && leg.nativeMarketId && leg.nativeSide) {
    return kalshiLiveBook.getAskSnapshot(leg.nativeMarketId, leg.nativeSide.toLowerCase() === "no" ? "no" : "yes");
  }
  return null;
};

export function isPolymarketKalshiNativePair(legs: Pick<ArbLeg, "venueId">[]): boolean {
  return legs.length === 2 &&
    legs.some((leg) => leg.venueId === "polymarket") &&
    legs.some((leg) => leg.venueId === "kalshi");
}

export function captureLiveExecutionSnapshot(
  legs: ArbLeg[],
  reader: LiveSnapshotReader,
  now = Date.now(),
  maxAgeMs = LIVE_EXECUTION_SNAPSHOT_FRESH_MS,
  depthMultiple = 1
): { snapshot: LiveExecutionSnapshot | null; reason: string } {
  if (legs.length !== 2 || !legs.every((leg) => leg.venueId === "polymarket" || leg.venueId === "kalshi")) {
    return { snapshot: null, reason: "native snapshot fast-path supports only two-leg Polymarket/Kalshi baskets" };
  }
  if (!isPolymarketKalshiNativePair(legs)) {
    return { snapshot: null, reason: "native snapshot requires one Polymarket and one Kalshi leg" };
  }
  const captured: LiveExecutionSnapshotLeg[] = [];
  for (const leg of legs) {
    const value = reader(leg);
    if (!value?.levels.length) return { snapshot: null, reason: `${leg.venueId} live ladder is missing or disconnected` };
    const ageMs = Math.max(0, now - value.updatedAt);
    if (ageMs > maxAgeMs) return { snapshot: null, reason: `${leg.venueId} live ladder is ${ageMs}ms old` };
    const levels = normalizeAskLevels(value.levels)
      .map((level) => Object.freeze({ ...level }))
      .sort((a, b) => a.priceCents - b.priceCents);
    if (!levels.length) return { snapshot: null, reason: `${leg.venueId} live ask ladder has no executable levels` };
    const availableContracts = levels.reduce((sum, level) => sum + level.contracts, 0);
    const requiredContracts = leg.size * Math.max(1, depthMultiple);
    if (availableContracts + 1e-9 < requiredContracts) {
      return {
        snapshot: null,
        reason: `${leg.venueId} live ladder has ${availableContracts.toFixed(2)} contracts; ${requiredContracts.toFixed(2)} buffered contracts required`,
      };
    }
    captured.push(Object.freeze({
      venueId: leg.venueId,
      marketId: leg.marketId,
      nativeMarketId: leg.nativeMarketId,
      nativeSide: leg.nativeSide,
      sourceUpdatedAt: value.updatedAt,
      levels: Object.freeze(levels),
    }));
  }
  const oldestAgeMs = Math.max(...captured.map((leg) => Math.max(0, now - leg.sourceUpdatedAt)));
  return {
    snapshot: Object.freeze({ capturedAt: now, oldestAgeMs, legs: Object.freeze(captured) }),
    reason: `complete Polymarket/Kalshi native ladders captured (${oldestAgeMs}ms oldest)`,
  };
}

export function captureCurrentLiveExecutionSnapshot(
  legs: ArbLeg[],
  now = Date.now(),
  maxAgeMs = LIVE_EXECUTION_SNAPSHOT_FRESH_MS,
  depthMultiple = 1
): { snapshot: LiveExecutionSnapshot | null; reason: string } {
  return captureLiveExecutionSnapshot(legs, currentLiveSnapshotForLeg, now, maxAgeMs, depthMultiple);
}

export function requestCurrentLiveExecutionSnapshotRecovery(legs: ArbLeg[]): void {
  for (const leg of legs) {
    if (leg.venueId === "polymarket" && leg.nativeSide) polymarketLiveBook.requestSnapshot(leg.nativeSide);
    if (leg.venueId === "kalshi" && leg.nativeMarketId) kalshiLiveBook.requestSnapshot(leg.nativeMarketId);
  }
}

export function currentLiveBookStates(legs: ArbLeg[]): Array<{ venueId: string; state: string; nativeId: string | null }> {
  return legs.map((leg) => {
    if (leg.venueId === "polymarket" && leg.nativeSide) {
      return { venueId: leg.venueId, state: polymarketLiveBook.marketState(leg.nativeSide), nativeId: leg.nativeSide };
    }
    if (leg.venueId === "kalshi" && leg.nativeMarketId) {
      return { venueId: leg.venueId, state: kalshiLiveBook.marketState(leg.nativeMarketId), nativeId: leg.nativeMarketId };
    }
    return { venueId: leg.venueId, state: "unsupported", nativeId: leg.nativeMarketId ?? leg.nativeSide ?? null };
  });
}

export async function waitForCurrentLiveExecutionSnapshot(
  legs: ArbLeg[],
  opts: { timeoutMs?: number; pollMs?: number; maxAgeMs?: number; depthMultiple?: number } = {}
): Promise<{ snapshot: LiveExecutionSnapshot | null; reason: string; states: ReturnType<typeof currentLiveBookStates> }> {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 2_000);
  const pollMs = Math.max(25, opts.pollMs ?? 100);
  const deadline = Date.now() + timeoutMs;
  let result = captureCurrentLiveExecutionSnapshot(legs, Date.now(), opts.maxAgeMs, opts.depthMultiple);
  if (result.snapshot) return { ...result, states: currentLiveBookStates(legs) };
  requestCurrentLiveExecutionSnapshotRecovery(legs);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    result = captureCurrentLiveExecutionSnapshot(legs, Date.now(), opts.maxAgeMs, opts.depthMultiple);
    if (result.snapshot) return { ...result, states: currentLiveBookStates(legs) };
  }
  const states = currentLiveBookStates(legs);
  return {
    ...result,
    reason: `${result.reason}; ${states.map((entry) => `${entry.venueId}=${entry.state}`).join(", ")}`,
    states,
  };
}
