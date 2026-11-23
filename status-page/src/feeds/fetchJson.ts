// One status feed fetch. Never throws: every failure becomes { ok: false } so its row shows
// "Couldn't check" and the rest of the page still renders. Cached at the edge for cacheSeconds so
// repeated page loads don't hit the vendor each time.

export type FetchResult = { ok: true; json: unknown } | { ok: false; reason: string };

export async function fetchJson(url: string, opts: { timeoutMs: number; cacheSeconds: number }): Promise<FetchResult> {
  const result = await attempt(url, opts);
  if (!result.ok) console.error(`status-page: feed ${new URL(url).host} failed: ${result.reason}`);
  return result;
}

async function attempt(url: string, opts: { timeoutMs: number; cacheSeconds: number }): Promise<FetchResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: opts.cacheSeconds, cacheEverything: true },
    } as RequestInit);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown';
    return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name };
  }
  if (!res.ok) return { ok: false, reason: `http ${res.status}` };
  let body: string;
  try {
    // The same deadline covers the body: a vendor that sends headers and then stalls must not
    // hold the page.
    body = await Promise.race([res.text(), aborted(signal)]);
  } catch {
    void res.body?.cancel().catch(() => {});
    return { ok: false, reason: 'timeout' };
  }
  try {
    return { ok: true, json: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, reason: 'not json' };
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
