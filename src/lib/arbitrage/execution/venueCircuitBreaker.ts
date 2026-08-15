type CircuitState = {
  reason: string;
  openedAtMs: number;
  expiresAtMs: number;
};

const DEFAULT_COOLDOWN_MS = 60_000;
const circuitGlobal = globalThis as typeof globalThis & { __arbVenueFailureCircuits?: Map<string, CircuitState> };

function circuits(): Map<string, CircuitState> {
  return (circuitGlobal.__arbVenueFailureCircuits ??= new Map());
}

export function isDeterministicVenueFailure(error: string | undefined): boolean {
  return /TAKER_INSUFFICIENT_BASE_TOKEN|insufficient (?:balance|funds|allowance|collateral)|allowance (?:too low|insufficient)|wallet .*insufficient/i.test(error ?? "");
}

export function recordVenueFailure(
  venueId: string,
  error: string | undefined,
  nowMs = Date.now(),
  cooldownMs = Math.max(1_000, Number(process.env.ARB_DETERMINISTIC_FAILURE_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS)
): boolean {
  if (!isDeterministicVenueFailure(error)) return false;
  circuits().set(venueId, { reason: error ?? "deterministic venue failure", openedAtMs: nowMs, expiresAtMs: nowMs + cooldownMs });
  return true;
}

export function clearVenueFailure(venueId: string): void {
  circuits().delete(venueId);
}

export function venueCircuitBlocker(venueId: string, nowMs = Date.now()): string | null {
  const state = circuits().get(venueId);
  if (!state) return null;
  if (state.expiresAtMs <= nowMs) {
    circuits().delete(venueId);
    return null;
  }
  return `${venueId} deterministic-failure cooldown active for ${Math.ceil((state.expiresAtMs - nowMs) / 1000)}s: ${state.reason}`;
}

export function resetVenueFailureCircuits(): void {
  circuits().clear();
}
