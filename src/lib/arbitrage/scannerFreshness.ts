export type ScannerSnapshotMeta = {
  scanning?: boolean;
  startedAt?: number;
  updatedAt?: number;
};

// Browser-side generation/age guard for cached scanner results. This protects against an
// old GET resolving after a stop/start and against a server cache that has stopped updating.
export function isScannerSnapshotFresh(
  snapshot: ScannerSnapshotMeta,
  clientGenerationStartedAt: number,
  now: number,
  maxAgeMs: number
): boolean {
  const serverStartedAt = Number(snapshot.startedAt);
  const updatedAt = Number(snapshot.updatedAt);
  return snapshot.scanning === true
    && Number.isFinite(serverStartedAt)
    && serverStartedAt > 0
    && Number.isFinite(updatedAt)
    && updatedAt >= serverStartedAt
    && updatedAt >= clientGenerationStartedAt
    && now - updatedAt >= 0
    && now - updatedAt <= maxAgeMs;
}
