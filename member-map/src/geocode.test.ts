import { describe, expect, it } from 'vitest';
import type { BoardRecord } from './monday/client';
import type { MapConfig } from './config';
import {
  addressHash, boardCoordinates, buildBatchCsv, CensusGeocoder, D1GeocodeStore, normalizeAddress,
  parseBatchResponse, resolveLocations, type BatchInput, type GeocodeRow, type GeocodeStore, type Geocoder, type LatLng,
} from './geocode';

const cfg: MapConfig['geocoder'] = {
  url: 'https://example.test/geocode', benchmark: 'Public_AR_Current', defaultState: 'CA',
  batchSize: 4, maxPerRun: 10, retryNoMatchDays: 90,
};
const NOW = new Date('2026-11-02T00:00:00Z');

function rec(id: string, over: Partial<BoardRecord> = {}): BoardRecord {
  return {
    itemId: id, boardId: 1, board: 'peopleLive', name: `n${id}`,
    address: `${id} Main St`, city: 'San Jose', zip: '95113', lat: null, lng: null,
    membershipStatus: null, doNotSolicit: false, ...over,
  };
}

class FakeStore implements GeocodeStore {
  rows = new Map<string, GeocodeRow>();
  async getMany(ids: string[]) {
    const m = new Map<string, GeocodeRow>();
    for (const id of ids) { const r = this.rows.get(id); if (r) m.set(id, r); }
    return m;
  }
  async putMany(rows: GeocodeRow[]) { for (const r of rows) this.rows.set(r.itemId, r); }
}

class FakeGeocoder implements Geocoder {
  batches: BatchInput[][] = [];
  failOn = -1;
  async geocode(rows: BatchInput[]) {
    this.batches.push(rows);
    if (this.batches.length - 1 === this.failOn) throw new Error('boom');
    return new Map<string, LatLng | null>(rows.map((r) => [r.id, { lat: 37.3, lng: -121.9 }]));
  }
}

async function cached(r: BoardRecord, status: 'match' | 'nomatch', at: Date): Promise<GeocodeRow> {
  const h = await addressHash(normalizeAddress(r)!);
  return { itemId: r.itemId, addressHash: h, status, lat: status === 'match' ? 1 : null, lng: status === 'match' ? 2 : null, geocodedAt: at.toISOString() };
}

describe('pure helpers', () => {
  it('boardCoordinates rejects junk', () => {
    for (const [a, b] of [['', ''], ['0', '0'], ['abc', '-121.9'], ['95', '-121.9'], ['37.3', '-200'], [null, null]] as const)
      expect(boardCoordinates(a, b)).toBeNull();
    expect(boardCoordinates('37.33', '-121.89')).toEqual({ lat: 37.33, lng: -121.89 });
  });
  it('parseBatchResponse reads "lon,lat" in that order', () => {
    const m = parseBatchResponse('"17","1 Main St, San Jose, CA, 95113","Match","Exact","1 MAIN ST, SAN JOSE, CA, 95113","-121.8863,37.3382","123","L"\n');
    expect(m.get('17')).toEqual({ lat: 37.3382, lng: -121.8863 });
  });
  it('No_Match and Tie are null', () => {
    const m = parseBatchResponse('"1","a, b","No_Match"\r\n"2","c, d","Tie","Non_Exact","x","-121.1,37.1","1","L"\n');
    expect(m.get('1')).toBeNull();
    expect(m.get('2')).toBeNull();
  });
  it('buildBatchCsv quotes a comma in the street', () =>
    expect(buildBatchCsv([{ id: '1', street: '10 A St, Apt 2', city: 'San Jose', state: 'CA', zip: '95113' }]))
      .toBe('1,"10 A St, Apt 2",San Jose,CA,95113\n'));
  it('normalizeAddress cuts ZIP+4 and is case-insensitive', () => {
    expect(normalizeAddress({ address: ' 1  Main St ', city: 'SAN JOSE', zip: '95113-1234' })).toBe('1 main st|san jose|95113');
    expect(normalizeAddress({ address: '  ', city: 'x', zip: '1' })).toBeNull();
    expect(normalizeAddress({ address: null, city: null, zip: null })).toBeNull();
  });
  it('addressHash is stable sha-256 hex', async () => {
    const h = await addressHash('a');
    expect(h).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});

describe('CensusGeocoder', () => {
  it('posts multipart addressFile + benchmark and parses the reply', async () => {
    let body: FormData | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
      body = init.body as FormData;
      return new Response('"1","x","Match","Exact","x","-121.5,37.5","1","L"\n');
    }) as typeof fetch;
    try {
      const out = await new CensusGeocoder(cfg).geocode([{ id: '1', street: 's', city: 'c', state: 'CA', zip: '9' }]);
      expect(out.get('1')).toEqual({ lat: 37.5, lng: -121.5 });
      expect(body!.get('benchmark')).toBe('Public_AR_Current');
      expect((body!.get('addressFile') as File).name).toBe('batch.csv');
    } finally { globalThis.fetch = orig; }
  });
  it('throws on a non-2xx reply', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('no', { status: 500 })) as typeof fetch;
    try { await expect(new CensusGeocoder(cfg).geocode([])).rejects.toThrow(/500/); }
    finally { globalThis.fetch = orig; }
  });
});

describe('D1GeocodeStore', () => {
  it('chunks the IN list at 100 and upserts in one batch', async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    let batched = 0;
    const db = {
      prepare(sql: string) {
        return { bind(...args: unknown[]) {
          const s = { sql, args, all: async () => { calls.push({ sql, args }); return { results: [] }; } };
          return s;
        } };
      },
      async batch(stmts: unknown[]) { batched = stmts.length; return []; },
    } as unknown as D1Database;
    const store = new D1GeocodeStore(db);
    await store.getMany(Array.from({ length: 250 }, (_, i) => String(i)));
    expect(calls.map((c) => c.args.length)).toEqual([100, 100, 50]);
    await store.putMany([{ itemId: '1', addressHash: 'h', status: 'nomatch', lat: null, lng: null, geocodedAt: 't' }]);
    expect(batched).toBe(1);
  });
});

describe('resolveLocations', () => {
  it('board coordinates win and are never sent', async () => {
    const g = new FakeGeocoder();
    const r = await resolveLocations([rec('1', { lat: '37.33', lng: '-121.89' })], new FakeStore(), g, cfg, NOW);
    expect(g.batches).toHaveLength(0);
    expect(r.located.get('1')).toEqual({ lat: 37.33, lng: -121.89 });
    expect(r.unplaced).toBe(0);
  });
  it('an unchanged cached address is not re-sent', async () => {
    const store = new FakeStore(); const g = new FakeGeocoder(); const a = rec('1');
    store.rows.set('1', await cached(a, 'match', NOW));
    const r = await resolveLocations([a], store, g, cfg, NOW);
    expect(g.batches).toHaveLength(0);
    expect(r.located.get('1')).toEqual({ lat: 1, lng: 2 });
  });
  it('a changed address is re-geocoded', async () => {
    const store = new FakeStore(); const g = new FakeGeocoder();
    store.rows.set('1', await cached(rec('1', { address: 'Old Rd' }), 'match', NOW));
    const r = await resolveLocations([rec('1')], store, g, cfg, NOW);
    expect(g.batches.flat()).toHaveLength(1);
    expect(r.geocoded).toBe(1);
    expect(store.rows.get('1')!.addressHash).toBe(await addressHash('1 main st|san jose|95113'));
    expect(r.located.get('1')).toEqual({ lat: 37.3, lng: -121.9 });
  });
  it('a recent nomatch is not retried; an old one is', async () => {
    const day = 86_400_000;
    for (const [age, sent] of [[89, 0], [91, 1]] as const) {
      const store = new FakeStore(); const g = new FakeGeocoder(); const a = rec('1');
      store.rows.set('1', await cached(a, 'nomatch', new Date(NOW.getTime() - age * day)));
      const r = await resolveLocations([a], store, g, cfg, NOW);
      expect(g.batches.flat()).toHaveLength(sent);
      if (!sent) { expect(r.unplaced).toBe(1); expect(r.located.size).toBe(0); }
    }
  });
  it('respects maxPerRun and batchSize', async () => {
    const g = new FakeGeocoder(); const store = new FakeStore();
    const recs = Array.from({ length: 12 }, (_, i) => rec(String(i + 1)));
    const r = await resolveLocations(recs, store, g, cfg, NOW);
    expect(g.batches.map((b) => b.length)).toEqual([4, 4, 2]);
    expect(r.unplaced).toBe(2);
    expect(r.geocoded).toBe(10);
    expect(store.rows.size).toBe(10);
  });
  it('sends state from config and street/city/zip', async () => {
    const g = new FakeGeocoder();
    await resolveLocations([rec('1', { zip: '95113-1234' })], new FakeStore(), g, cfg, NOW);
    expect(g.batches[0]?.[0]).toEqual({ id: '1', street: '1 Main St', city: 'San Jose', state: 'CA', zip: '95113' });
  });
  it('a failing batch leaves its records unplaced and the run continues', async () => {
    const g = new FakeGeocoder(); g.failOn = 0; const store = new FakeStore();
    const recs = Array.from({ length: 6 }, (_, i) => rec(String(i + 1)));
    const r = await resolveLocations(recs, store, g, cfg, NOW);
    expect(g.batches).toHaveLength(2);
    expect(r.located.size).toBe(2);
    expect(r.unplaced).toBe(4);
    expect(store.rows.size).toBe(2);
  });
  it('no address and no coordinates → unplaced, not sent', async () => {
    const g = new FakeGeocoder();
    const r = await resolveLocations([rec('1', { address: null })], new FakeStore(), g, cfg, NOW);
    expect(g.batches).toHaveLength(0);
    expect(r.unplaced).toBe(1);
  });
  it('a putMany failure fails the whole batch once and the run continues', async () => {
    const g = new FakeGeocoder(); const store = new FakeStore();
    const real = store.putMany.bind(store); let n = 0;
    store.putMany = async (rows) => { if (n++ === 0) throw new Error('d1 down'); return real(rows); };
    const recs = Array.from({ length: 6 }, (_, i) => rec(String(i + 1)));
    const r = await resolveLocations(recs, store, g, cfg, NOW);
    expect(g.batches).toHaveLength(2);
    expect(r.located.size).toBe(2);
    expect([...r.located.keys()]).toEqual(['5', '6']);
    expect(r.unplaced).toBe(4);
    expect(store.rows.size).toBe(2);
  });
  it('an id missing from the reply is not cached and counts unplaced; others are cached', async () => {
    const store = new FakeStore();
    const g: Geocoder = { geocode: async (rows) => new Map(rows.filter((r) => r.id !== '2').map((r) => [r.id, { lat: 37.3, lng: -121.9 }])) };
    const r = await resolveLocations([rec('1'), rec('2'), rec('3')], store, g, cfg, NOW);
    expect([...store.rows.keys()].sort()).toEqual(['1', '3']);
    expect(r.unplaced).toBe(1);
    expect(r.located.size).toBe(2);
  });
  it('a garbage or empty 200 body fails the batch and caches nothing', async () => {
    const orig = globalThis.fetch;
    for (const body of ['', '<html>Service Unavailable</html>']) {
      globalThis.fetch = (async () => new Response(body)) as typeof fetch;
      const store = new FakeStore();
      try {
        const r = await resolveLocations([rec('1'), rec('2')], store, new CensusGeocoder(cfg), cfg, NOW);
        expect(store.rows.size).toBe(0);
        expect(r.unplaced).toBe(2);
        expect(r.located.size).toBe(0);
      } finally { globalThis.fetch = orig; }
    }
  });
});
