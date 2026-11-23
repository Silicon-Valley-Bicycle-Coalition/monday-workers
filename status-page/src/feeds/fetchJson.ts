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
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: opts.cacheSeconds, cacheEverything: true },
    } as RequestInit);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown';
    return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name };
  }
  if (!res.ok) return { ok: false, reason: `http ${res.status}` };
  try {
    return { ok: true, json: JSON.parse(await res.text()) as unknown };
  } catch {
    return { ok: false, reason: 'not json' };
  }
}
