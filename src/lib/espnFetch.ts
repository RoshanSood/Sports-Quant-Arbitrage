const DEFAULT_RETRY_DELAYS_MS = [0, 250, 750];

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Read fresh ESPN JSON without Next's response cache. A TLS reset while Next is caching an
 * upstream response can surface as "failed to pipe response"; no-store avoids that cache
 * pipeline. Transient network/HTTP failures are retried, with deliberately no abort timeout.
 */
export async function fetchEspnJson<T>(
  url: string,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS
): Promise<T> {
  let lastError: unknown = new Error("ESPN request did not run");

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    await wait(retryDelaysMs[attempt]);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const error = new Error(`ESPN API error: ${response.status}`);
        if (!retryableStatus(response.status)) throw error;
        lastError = error;
        continue;
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      // Client errors are deterministic and should not be retried.
      if (error instanceof Error && /^ESPN API error: 4\d\d$/.test(error.message)) throw error;
    }
  }

  throw new Error(
    `ESPN request failed after ${retryDelaysMs.length} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError }
  );
}
