import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from './fetchJson';

const opts = { timeoutMs: 3000, cacheSeconds: 60 };
let calls: { url: string; init: RequestInit & { cf?: { cacheTtl?: number; cacheEverything?: boolean } } }[];
function stub(respond: (init: RequestInit) => Promise<Response>) {
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(init);
  });
}
afterEach(() => vi.unstubAllGlobals());
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('fetchJson', () => {
  it('returns json on 200', async () => {
    stub(async () => Response.json({ a: 1 }));
    expect(await fetchJson('https://status.monday.com/api/v2/summary.json', opts)).toEqual({ ok: true, json: { a: 1 } });
  });

  it('parses non-JSON 200 as unknown', async () => {
    stub(async () => new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } }));
    expect(await fetchJson('https://status.eventbrite.com/', opts)).toEqual({ ok: false, reason: 'not json' });
  });

  it('http 503 is a failure', async () => {
    stub(async () => new Response('down', { status: 503 }));
    expect(await fetchJson('https://x.test/', opts)).toEqual({ ok: false, reason: 'http 503' });
  });

  it('times out a hanging feed as unknown', async () => {
    stub((init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const started = Date.now();
    expect(await fetchJson('https://slow.test/', { timeoutMs: 20, cacheSeconds: 60 })).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a thrown network error is a failure named by the error', async () => {
    stub(async () => { throw new TypeError('fetch failed'); });
    expect(await fetchJson('https://x.test/', opts)).toEqual({ ok: false, reason: 'TypeError' });
  });

  it('passes cacheTtl', async () => {
    stub(async () => Response.json({}));
    await fetchJson('https://x.test/', opts);
    expect(calls[0]!.init.cf).toEqual({ cacheTtl: 60, cacheEverything: true });
  });
});

describe('a body that stalls after the headers', () => {
  it('times out as unknown instead of hanging', async () => {
    stub(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }));
    const started = Date.now();
    expect(await fetchJson('https://slow-body.test/', { timeoutMs: 20, cacheSeconds: 60 })).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
