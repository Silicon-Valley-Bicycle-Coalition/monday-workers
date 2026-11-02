import { afterEach, describe, expect, it, vi } from 'vitest';
import match from './fixtures/census-match.json';
import noMatch from './fixtures/census-no-match.json';
import { addressHash, geocodeOne, runGeocode } from './geocode';
import type { WriteMode } from './flags';
import { CONFIG, FakeD1, FakeMonday } from './testing';
import type { SourceBoard } from './config';

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const URL_ = 'https://census.example';

describe('geocodeOne', () => {
  it('parses the first match (x = lng, y = lat) and builds the onelineaddress query', async () => {
    const f = vi.fn((_u: string, _i?: RequestInit) => json(match)());
    const r = await geocodeOne('200 E Santa Clara St, San Jose, CA 95113', URL_, f as unknown as typeof fetch);
    expect(r).toEqual({ lat: 37.338163163635, lng: -121.886224209159 });
    const url = new URL(f.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe(URL_ + '/');
    expect(url.searchParams.get('address')).toBe('200 E Santa Clara St, San Jose, CA 95113');
    expect(url.searchParams.get('benchmark')).toBe('Public_AR_Current');
    expect(url.searchParams.get('format')).toBe('json');
  });
  it('returns null on an empty addressMatches', async () => {
    expect(await geocodeOne('x', URL_, json(noMatch) as unknown as typeof fetch)).toBeNull();
  });
  it('throws on an HTTP error (not a miss)', async () => {
    await expect(geocodeOne('x', URL_, json({}, 500) as unknown as typeof fetch)).rejects.toThrow();
  });
});

class GeoMonday extends FakeMonday {
  candidates: Record<string, { id: string; address: string }[]> = {};
  listCalls: [string, number][] = [];
  set: [string, string, number, number][] = [];
  constructor() { super(null); }
  override async listMissingCoordinates(src: SourceBoard, limit: number) {
    this.listCalls.push([src.kind, limit]);
    return (this.candidates[src.kind] ?? []).slice(0, limit);
  }
  override async setCoordinates(src: SourceBoard, itemId: string, lat: number, lng: number) { this.set.push([src.kind, itemId, lat, lng]); }
}

const cand = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, address: `${i} Main St, San Jose, CA 95113` }));
const run = (monday: GeoMonday, db: FakeD1, mode: WriteMode = 'on', perRun = 200) =>
  runGeocode({ monday, db: db as unknown as D1Database, config: { ...CONFIG, geocode: { ...CONFIG.geocode, perRun } }, mode });

function stubCensus(responder: (address: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const a = new URL(u).searchParams.get('address')!;
    seen.push(a);
    return responder(a);
  }));
  return seen;
}
const ok = () => new Response(JSON.stringify(match));
const none = () => new Response(JSON.stringify(noMatch));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('runGeocode', () => {
  it('writes coordinates for matches and processes only sources with an address', async () => {
    stubCensus(ok);
    const m = new GeoMonday(); m.candidates = { person: cand(1), historical: cand(1, 'h'), organization: cand(1, 'o') };
    const r = await run(m, new FakeD1());
    expect(r).toEqual({ geocoded: 2, missed: 0, skipped: 0 });
    expect(m.listCalls.map(([k]) => k)).toEqual(['person', 'organization']);
    expect(m.set[0]).toEqual(['person', 'p0', 37.338163163635, -121.886224209159]);
  });
  it('records a miss and skips the same address next run', async () => {
    const seen = stubCensus(none);
    const m = new GeoMonday(); m.candidates = { person: cand(1) };
    const db = new FakeD1();
    expect(await run(m, db)).toEqual({ geocoded: 0, missed: 1, skipped: 0 });
    expect(db.misses.get('p0')?.address_hash).toBe(await addressHash('0 Main St, San Jose, CA 95113'));
    expect(await run(m, db)).toEqual({ geocoded: 0, missed: 0, skipped: 1 });
    expect(seen).toHaveLength(1);
    expect(m.set).toEqual([]);
  });
  it('retries an item whose address changed', async () => {
    const seen = stubCensus(none);
    const m = new GeoMonday(); m.candidates = { person: cand(1) };
    const db = new FakeD1();
    await run(m, db);
    m.candidates = { person: [{ id: 'p0', address: '9 Other St, San Jose, CA 95113' }] };
    expect(await run(m, db)).toEqual({ geocoded: 0, missed: 1, skipped: 0 });
    expect(seen).toHaveLength(2);
    expect(db.misses.get('p0')?.address_hash).toBe(await addressHash('9 Other St, San Jose, CA 95113'));
  });
  it('hashes the normalized address (case and whitespace insensitive)', async () => {
    expect(await addressHash('  1  Main St,  SAN JOSE ')).toBe(await addressHash('1 main st, san jose'));
    expect(await addressHash('a')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('off geocodes but never calls setCoordinates', async () => {
    const seen = stubCensus(ok);
    const m = new GeoMonday(); m.candidates = { person: cand(2) };
    const r = await run(m, new FakeD1(), 'off');
    expect(r.geocoded).toBe(2);
    expect(seen).toHaveLength(2);
    expect(m.set).toEqual([]);
  });
  it.each(['hold', 'unknown'] as const)('%s makes no Monday, Census or D1 calls', async (mode) => {
    const seen = stubCensus(ok);
    const m = new GeoMonday(); m.candidates = { person: cand(2) };
    const db = new FakeD1();
    const prepare = vi.spyOn(db, 'prepare');
    expect(await run(m, db, mode)).toEqual({ geocoded: 0, missed: 0, skipped: 0 });
    expect(m.listCalls).toEqual([]);
    expect(seen).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('perRun 2 with 5 candidates processes 2, sharing the budget across sources', async () => {
    const seen = stubCensus(ok);
    const m = new GeoMonday(); m.candidates = { person: cand(5), organization: cand(5, 'o') };
    expect(await run(m, new FakeD1(), 'on', 2)).toEqual({ geocoded: 2, missed: 0, skipped: 0 });
    expect(seen).toHaveLength(2);
    expect(m.listCalls).toEqual([['person', 2]]);
  });
  it('over-fetches past recorded misses so they cannot starve fresh items', async () => {
    stubCensus(ok);
    const m = new GeoMonday(); m.candidates = { person: cand(3) };
    const db = new FakeD1();
    db.misses.set('p0', { address_hash: await addressHash('0 Main St, San Jose, CA 95113'), attempted_at: 'x' });
    const r = await run(m, db, 'on', 2);
    expect(m.listCalls[0]).toEqual(['person', 3]);
    expect(r).toEqual({ geocoded: 2, missed: 0, skipped: 1 });
  });
  it('a Census error skips the item without recording a miss; 3 in a row stop the run', async () => {
    const seen = stubCensus(() => new Response('boom', { status: 503 }));
    const m = new GeoMonday(); m.candidates = { person: cand(6) };
    const db = new FakeD1();
    expect(await run(m, db)).toEqual({ geocoded: 0, missed: 0, skipped: 3 });
    expect(seen).toHaveLength(3);
    expect(db.misses.size).toBe(0);
  });
  it('a success resets the consecutive-error count', async () => {
    let n = 0;
    stubCensus(() => (++n % 3 === 0 ? ok() : new Response('boom', { status: 500 })));
    const m = new GeoMonday(); m.candidates = { person: cand(6) };
    const r = await run(m, new FakeD1());
    expect(r).toEqual({ geocoded: 2, missed: 0, skipped: 4 });
  });
  it('logs counts only, never an address', async () => {
    stubCensus(none);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = new GeoMonday(); m.candidates = { person: cand(1) };
    await run(m, new FakeD1());
    const out = JSON.stringify([...log.mock.calls, ...err.mock.calls]);
    expect(out).not.toContain('Main St');
  });
});
