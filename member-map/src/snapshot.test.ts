import { describe, expect, it, vi } from 'vitest';
import { buildSnapshot, kindOf, runRefresh, type Snapshot } from './snapshot';
import type { BlockGroupIndex } from './assign';
import type { BoardKey, BoardRecord, MapMondayClient } from './monday/client';
import type { BlockGroupProps } from './reference/types';
import type { GeocodeStore, Geocoder, LatLng } from './geocode';
import { validateConfig, type MapConfig } from './config';
import svbc from '../config/svbc.json';

const cfg: MapConfig = validateConfig({ ...svbc, boards: { peopleLive: 11, peopleHistorical: 0, organizations: 33 } });
const NOW = new Date('2026-11-02T10:00:00Z');

function rec(id: string, status: string | null, over: Partial<BoardRecord> = {}): BoardRecord {
  return {
    itemId: id, boardId: 11, board: 'peopleLive', name: `Name ${id}`, address: null, city: null, zip: null,
    lat: null, lng: null, membershipStatus: status, doNotSolicit: false, ...over,
  };
}
const org = (id: string): BoardRecord => rec(id, null, { board: 'organizations', boardId: 33 });

function bg(geoid: string, population: number): BlockGroupProps {
  return {
    GEOID: geoid, population, medianIncome: null, epc: false, roadMiles: 1,
    bikeMiles: { '1': 0, '2': 0, '3': 0, '4': 0 }, weightedBikeMiles: 0, bikeDensity: null, bikeClass: null,
  };
}

// Longitude picks the block group: <1 is A, 1..2 is B, 2..3 is C, else outside.
const index: BlockGroupIndex = {
  find: (lng) => (lng < 0 ? null : lng < 1 ? 'A' : lng < 2 ? 'B' : lng < 3 ? 'C' : null),
};
const at = (lng: number): LatLng => ({ lat: 37, lng });

describe('kindOf', () => {
  it('maps Active/Lapsed/blank/org', () => {
    expect(kindOf(rec('1', 'Active'), 'Active')).toBe('member');
    expect(kindOf(rec('2', 'Lapsed'), 'Active')).toBe('lapsed');
    expect(kindOf(rec('3', null), 'Active')).toBe('never');
    expect(kindOf(rec('4', 'Prospect'), 'Active')).toBe('never');
    expect(kindOf(org('5'), 'Active')).toBe('org');
    expect(kindOf(rec('6', 'Gold'), 'Gold')).toBe('member');
  });
});

describe('buildSnapshot', () => {
  const reference = [bg('A', 1000), bg('B', 1000), bg('C', 50)];

  it('counts members, lapsed and never per block group; orgs not counted', () => {
    const records = [rec('1', 'Active'), rec('2', 'Active'), rec('3', 'Lapsed'), rec('4', null), org('5'), rec('6', 'Active')];
    const located = new Map([['1', at(0.5)], ['2', at(0.6)], ['3', at(0.7)], ['4', at(0.8)], ['5', at(0.9)], ['6', at(1.5)]]);
    const s = buildSnapshot(records, located, 0, index, reference, cfg, 100, NOW);
    expect(s.blockGroups['A']).toMatchObject({ members: 2, lapsed: 1, never: 1 });
    expect(s.blockGroups['B']).toMatchObject({ members: 1, lapsed: 0, never: 0 });
    expect(s.points).toHaveLength(6);
    expect(s.points.find((p) => p.id === '5')?.kind).toBe('org');
  });

  it('every reference GEOID appears, zero-filled', () => {
    const s = buildSnapshot([], new Map(), 0, index, reference, cfg, 100, NOW);
    expect(Object.keys(s.blockGroups).sort()).toEqual(['A', 'B', 'C']);
    expect(s.blockGroups['B']).toMatchObject({ members: 0, lapsed: 0, never: 0 });
  });

  it('a block group under 100 residents has null popClass and leadClass', () => {
    const s = buildSnapshot([rec('1', 'Lapsed')], new Map([['1', at(2.5)]]), 0, index, reference, cfg, 100, NOW);
    expect(s.blockGroups['C']).toMatchObject({ lapsed: 1, popClass: null, leadClass: null });
  });

  it('a 4,200-resident block group with 0 members is a population gap', () => {
    const ref = [bg('A', 4200), bg('B', 1000), bg('C', 1000)];
    const records = [rec('1', 'Active'), rec('2', 'Active'), rec('3', 'Active')];
    const located = new Map([['1', at(1.1)], ['2', at(1.2)], ['3', at(2.1)]]);
    const s = buildSnapshot(records, located, 0, index, ref, cfg, 100, NOW);
    expect(s.blockGroups['A']?.popClass).toBe(3);
    expect(s.blockGroups['B']?.popClass).toBe(0);
  });

  it('leadClass ranks lapsed + never, high is the gap', () => {
    const ref = [bg('A', 1000), bg('B', 1000), bg('C', 1000)];
    const records = [rec('1', 'Lapsed'), rec('2', null), rec('3', 'Lapsed')];
    const located = new Map([['1', at(0.1)], ['2', at(0.2)], ['3', at(0.3)]]);
    const s = buildSnapshot(records, located, 0, index, ref, cfg, 100, NOW);
    expect(s.blockGroups['A']?.leadClass).toBe(3);
    expect(s.blockGroups['B']?.leadClass).toBe(0);
  });

  it('points outside every block group count in outsideArea, not in blockGroups', () => {
    const s = buildSnapshot([rec('1', 'Active')], new Map([['1', at(9)]]), 0, index, reference, cfg, 100, NOW);
    expect(s.outsideArea).toBe(1);
    expect(s.points).toHaveLength(1);
    expect(Object.values(s.blockGroups).every((c) => c.members === 0)).toBe(true);
  });

  it('records without a location are not points; unplaced is passed through', () => {
    const s = buildSnapshot([rec('1', 'Active')], new Map(), 7, index, reference, cfg, 100, NOW);
    expect(s.points).toEqual([]);
    expect(s.unplaced).toBe(7);
  });

  it('point carries id, board, name, coordinates and do-not-solicit', () => {
    const s = buildSnapshot([rec('1', 'Active', { doNotSolicit: true })], new Map([['1', { lat: 37.1, lng: 0.5 }]]), 0, index, reference, cfg, 100, NOW);
    expect(s.points[0]).toEqual({ id: '1', boardId: 11, name: 'Name 1', lat: 37.1, lng: 0.5, kind: 'member', dns: true });
  });

  it('asOf is now.toISOString() and accountUrl comes from config', () => {
    const s = buildSnapshot([], new Map(), 0, index, reference, cfg, 100, NOW);
    expect(s.asOf).toBe('2026-11-02T10:00:00.000Z');
    expect(s.accountUrl).toBe(cfg.monday.accountUrl);
  });
});

describe('runRefresh', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', properties: { ...bg('A', 1000) },
      geometry: { type: 'Polygon', coordinates: [[[0, 36], [1, 36], [1, 38], [0, 38], [0, 36]]] },
    }],
  };
  function setup() {
    const reads: [BoardKey, number][] = [];
    const monday: MapMondayClient = {
      readBoard: async (board, boardId) => {
        reads.push([board, boardId]);
        return board === 'peopleLive' ? [rec('1', 'Active', { lat: '37', lng: '0.5' })] : [org('9')];
      },
    };
    const store: GeocodeStore = { getMany: async () => new Map(), putMany: async () => {} };
    const geocoder: Geocoder = { geocode: async () => new Map() };
    const fetched: string[] = [];
    const assets = { fetch: async (req: Request) => { fetched.push(req.url); return new Response(JSON.stringify(fc)); } } as unknown as Fetcher;
    const put = vi.fn(async () => ({}));
    const bucket = { put } as unknown as R2Bucket;
    return { reads, monday, store, geocoder, assets, bucket, put, fetched };
  }

  it('skips board id 0 and writes snapshot.json to the bucket', async () => {
    const s = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const snap = await runRefresh({ monday: s.monday, store: s.store, geocoder: s.geocoder, assets: s.assets, bucket: s.bucket, config: cfg, now: NOW });
    expect(s.reads.map((r) => r[0])).toEqual(['peopleLive', 'organizations']);
    expect(s.fetched).toEqual(['https://assets.local/data/blockgroups.geojson']);
    expect(s.put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = s.put.mock.calls[0] as unknown as [string, string, { httpMetadata: { contentType: string } }];
    expect(key).toBe('snapshot.json');
    expect(opts.httpMetadata.contentType).toBe('application/json');
    const written = JSON.parse(body) as Snapshot;
    expect(written).toEqual(snap);
    expect(written.blockGroups['A']?.members).toBe(1);
    expect(written.points).toHaveLength(1); // the org has no location
    const lines = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('peopleHistorical board id not configured');
    expect(lines).not.toContain('Name 1');
    log.mockRestore();
  });

  it('does not write when the assets fetch fails', async () => {
    const s = setup();
    const assets = { fetch: async () => new Response('nope', { status: 404 }) } as unknown as Fetcher;
    await expect(runRefresh({ monday: s.monday, store: s.store, geocoder: s.geocoder, assets, bucket: s.bucket, config: cfg, now: NOW })).rejects.toThrow();
    expect(s.put).not.toHaveBeenCalled();
  });
});
