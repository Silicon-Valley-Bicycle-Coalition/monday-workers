// Retry-with-backoff for the geocode stage's HTTP calls. The Census batch endpoint stalls
// routinely (undici surfaces it as UND_ERR_HEADERS_TIMEOUT after ~5 min) and one transient
// network failure must not kill a multi-hour pipeline run — this crashed the first v2
// rehearsal launch on its very first request (2026-08-25, rehearsal-run.log).
export interface RetryDeps { sleepFn?: (ms: number) => Promise<void> }

export async function withRetry<T>(
  fn: () => Promise<T>, label: string, deps: RetryDeps = {}, attempts = 4,
): Promise<T> {
  const sleep = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const ms = 5_000 * 3 ** i; // 5s, 15s, 45s
        console.warn(`${label}: attempt ${i + 1}/${attempts} failed (${String(err)}) — retrying in ${ms / 1000}s`);
        await sleep(ms);
      }
    }
  }
  throw lastErr;
}
