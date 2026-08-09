import { describe, expect, it } from "vitest";
import { isScannerSnapshotFresh } from "./scannerFreshness";

describe("isScannerSnapshotFresh", () => {
  const now = 10_000;

  it("accepts only a recent completed scan from the current generation", () => {
    expect(isScannerSnapshotFresh({ scanning: true, startedAt: 8_000, updatedAt: 9_500 }, 8_000, now, 2_000)).toBe(true);
  });

  it("rejects a cached result from before the browser restarted scanning", () => {
    expect(isScannerSnapshotFresh({ scanning: true, startedAt: 5_000, updatedAt: 7_000 }, 8_000, now, 5_000)).toBe(false);
  });

  it("rejects stopped, incomplete, future, and aged snapshots", () => {
    expect(isScannerSnapshotFresh({ scanning: false, startedAt: 8_000, updatedAt: 9_500 }, 8_000, now, 2_000)).toBe(false);
    expect(isScannerSnapshotFresh({ scanning: true, startedAt: 8_000, updatedAt: 0 }, 8_000, now, 2_000)).toBe(false);
    expect(isScannerSnapshotFresh({ scanning: true, startedAt: 8_000, updatedAt: 10_001 }, 8_000, now, 2_000)).toBe(false);
    expect(isScannerSnapshotFresh({ scanning: true, startedAt: 8_000, updatedAt: 8_500 }, 8_000, now, 1_000)).toBe(false);
  });
});
