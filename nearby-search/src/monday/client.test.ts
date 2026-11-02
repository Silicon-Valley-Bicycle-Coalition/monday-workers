import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceBoard } from '../config';
import { HttpNearbyMondayClient, toContact } from './client';

const SRC: SourceBoard = {
  kind: 'person', boardId: 10, latColumn: 'lat', lngColumn: 'lng', nameColumn: null, nearbyColumn: 'nearby', address: null,
};

const raw = (lat: string | null, lng: string | null, extra: { id: string; text: string | null }[] = []) => ({
  id: '1', name: 'Ada',
  column_values: [{ id: 'lat', text: lat }, { id: 'lng', text: lng }, ...extra],
});

describe('toContact', () => {
  it('nulls coordinates that are both zero', () => {
    const c = toContact(raw('0', '0'), SRC);
    expect([c.lat, c.lng]).toEqual([null, null]);
  });
  it('nulls blank and non-numeric coordinates', () => {
    expect(toContact(raw('', ''), SRC).lat).toBeNull();
    expect(toContact(raw('abc', '-121.8'), SRC).lat).toBeNull();
    expect(toContact(raw(null, null), SRC).lng).toBeNull();
  });
  it('parses real coordinates, sets kind, and leaves zip null', () => {
    const c = toContact(raw('37.33', '-121.89'), SRC);
    expect(c).toEqual({ id: '1', name: 'Ada', lat: 37.33, lng: -121.89, zip: null, kind: 'person' });
  });
  it('prefers the name column when set and non-blank', () => {
    const src = { ...SRC, nameColumn: 'full' };
    expect(toContact(raw('1', '2', [{ id: 'full', text: 'Ada L' }]), src).name).toBe('Ada L');
    expect(toContact(raw('1', '2', [{ id: 'full', text: ' ' }]), src).name).toBe('Ada');
  });
});

type Body = { query: string; variables: Record<string, any> };

// Answers each request with the first matching responder, recording every body.
function stub(responders: [string, (b: Body) => unknown][]) {
  const bodies: Body[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Body;
    bodies.push(body);
    const hit = responders.find(([needle]) => body.query.includes(needle));
    if (!hit) throw new Error(`unexpected query: ${body.query}`);
    return new Response(JSON.stringify({ data: hit[1](body) }), { status: 200 });
  }));
  return bodies;
}

const client = () => new HttpNearbyMondayClient('https://api.test/v2', 'tok');
const cols = [
  { id: 'conn', title: 'Nearby contact', type: 'board_relation' },
  { id: 'lbl', title: 'Nearby search', type: 'text' },
];

describe('HttpNearbyMondayClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('listContacts follows the cursor across pages', async () => {
    const bodies = stub([
      ['next_items_page', () => ({ next_items_page: { cursor: null, items: [raw('3', '4')].map((r) => ({ ...r, id: '2' })) } })],
      ['items_page', () => ({ boards: [{ items_page: { cursor: 'c1', items: [raw('1', '2')] } }] })],
    ]);
    const out = await client().listContacts(SRC);
    expect(out.map((c) => c.id)).toEqual(['1', '2']);
    expect(bodies[1]?.variables.cursor).toBe('c1');
  });

  it('addNearbyLabel sends no mutation when the label is already present', async () => {
    const bodies = stub([['items(', () => ({ items: [{ column_values: [{ text: 'Old, New' }] }] })]]);
    await client().addNearbyLabel('5', 10, 'nearby', 'New');
    expect(bodies.some((b) => b.query.includes('change_column_value'))).toBe(false);
  });

  it('addNearbyLabel appends to existing labels', async () => {
    const bodies = stub([
      ['change_column_value', () => ({ change_column_value: { id: '5' } })],
      ['items(', () => ({ items: [{ column_values: [{ text: 'Old' }] }] })],
    ]);
    await client().addNearbyLabel('5', 10, 'nearby', 'New');
    const m = bodies.find((b) => b.query.includes('change_column_value'));
    expect(JSON.parse(m?.variables.value)).toEqual({ labels: ['Old', 'New'] });
    expect(m?.query).toContain('create_labels_if_missing: true');
  });

  it('ensureResultColumns creates nothing when both titles exist', async () => {
    const bodies = stub([['columns', () => ({ boards: [{ columns: cols }] })]]);
    expect(await client().ensureResultColumns(7, [10])).toEqual({ connectColumnId: 'conn', labelColumnId: 'lbl' });
    expect(bodies.some((b) => b.query.includes('create_column'))).toBe(false);
  });

  it('ensureResultColumns creates the missing columns', async () => {
    const bodies = stub([
      ['create_column', (b) => ({ create_column: { id: b.variables.type === 'board_relation' ? 'newc' : 'newl' } })],
      ['columns', () => ({ boards: [{ columns: [] }] })],
    ]);
    expect(await client().ensureResultColumns(7, [10, 11])).toEqual({ connectColumnId: 'newc', labelColumnId: 'newl' });
    const create = bodies.find((b) => b.variables.type === 'board_relation');
    expect(JSON.parse(create?.variables.defaults)).toEqual({ boardIds: [10, 11] });
  });

  it('findResultColumns returns null when a title is missing and never writes', async () => {
    const bodies = stub([['columns', () => ({ boards: [{ columns: [cols[0]] }] })]]);
    expect(await client().findResultColumns(7)).toBeNull();
    expect(bodies).toHaveLength(1);
  });

  it('createResultRow sets the connect and label columns', async () => {
    const bodies = stub([['create_item', () => ({ create_item: { id: '99' } })]]);
    const id = await client().createResultRow(7, 'Ada', { connectColumnId: 'conn', labelColumnId: 'lbl' }, '42', 'Q');
    expect(id).toBe('99');
    expect(JSON.parse(bodies[0]?.variables.values)).toEqual({ conn: { item_ids: [42] }, lbl: 'Q' });
  });

  it('listBoards returns active boards sorted by name', async () => {
    const bodies = stub([['boards(', () => ({ boards: [{ id: '2', name: 'b' }, { id: '1', name: 'a' }] })]]);
    expect((await client().listBoards([5])).map((b) => b.id)).toEqual(['1', '2']);
    expect(bodies[0]?.query).toContain('state: active');
  });

  it('getEventAddress returns null for a wrong board or blank address, else the address', async () => {
    const item = (board: string, text: string | null) => ({ items: [{ name: 'Ride', board: { id: board }, column_values: [{ text }] }] });
    stub([['items(', () => item('9', 'San Jose, CA')]]);
    expect(await client().getEventAddress(9, '1', 'addr')).toEqual({ name: 'Ride', address: 'San Jose, CA' });
    expect(await client().getEventAddress(8, '1', 'addr')).toBeNull();
    stub([['items(', () => item('9', '')]]);
    expect(await client().getEventAddress(9, '1', 'addr')).toBeNull();
    stub([['items(', () => ({ items: [] })]]);
    expect(await client().getEventAddress(9, '1', 'addr')).toBeNull();
  });

  it('linkedContactIds unions linked ids across pages', async () => {
    stub([
      ['next_items_page', () => ({ next_items_page: { cursor: null, items: [{ column_values: [{ linked_item_ids: ['3'] }] }] } })],
      ['items_page', () => ({ boards: [{ items_page: { cursor: 'c', items: [{ column_values: [{ linked_item_ids: ['1', '2'] }] }] } }] })],
    ]);
    expect([...(await client().linkedContactIds(7, 'conn'))].sort()).toEqual(['1', '2', '3']);
  });
});

describe('geocode backfill methods', () => {
  afterEach(() => vi.unstubAllGlobals());
  const SRC_ADDR: SourceBoard = { ...SRC, address: { street: 'st', city: 'ct', state: 'se', zip: 'zp' } };
  const item = (id: string, vals: Record<string, string | null>) => ({ id, column_values: Object.entries(vals).map(([k, text]) => ({ id: k, text })) });

  it('listMissingCoordinates filters on empty lat / non-empty street and joins the address', async () => {
    const bodies = stub([['items_page', () => ({ boards: [{ items_page: { cursor: null, items: [item('1', { st: '1 Main St', ct: 'San Jose', se: 'CA', zp: '95113' }), item('2', { st: '2 Oak', ct: null, se: 'CA', zp: '' })] } }] })]]);
    const out = await client().listMissingCoordinates(SRC_ADDR, 10);
    expect(out).toEqual([{ id: '1', address: '1 Main St, San Jose, CA, 95113' }, { id: '2', address: '2 Oak, CA' }]);
    expect(bodies[0]!.variables.qp).toEqual({
      operator: 'and',
      rules: [{ column_id: 'lat', compare_value: [], operator: 'is_empty' }, { column_id: 'st', compare_value: [], operator: 'is_not_empty' }],
    });
    expect(bodies[0]!.variables.columnIds).toEqual(['st', 'ct', 'se', 'zp']);
  });
  it('follows the cursor up to the limit and no further', async () => {
    const bodies = stub([
      ['next_items_page', () => ({ next_items_page: { cursor: 'c2', items: [item('3', { st: 'c' }), item('4', { st: 'd' })] } })],
      ['items_page(', () => ({ boards: [{ items_page: { cursor: 'c1', items: [item('1', { st: 'a' }), item('2', { st: 'b' })] } }] })],
    ]);
    const out = await client().listMissingCoordinates(SRC_ADDR, 3);
    expect(out.map((o) => o.id)).toEqual(['1', '2', '3']);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.query).toContain('limit: 1,');
  });
  it('returns nothing for a board with no address columns', async () => {
    const bodies = stub([]);
    expect(await client().listMissingCoordinates(SRC, 5)).toEqual([]);
    expect(bodies).toHaveLength(0);
  });
  it('setCoordinates writes both columns as 6-decimal strings in one mutation', async () => {
    const bodies = stub([['change_multiple_column_values', () => ({ change_multiple_column_values: { id: '9' } })]]);
    await client().setCoordinates(SRC, '9', 37.3381631636, -121.88622);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.variables).toMatchObject({ boardId: '10', itemId: '9' });
    expect(JSON.parse(bodies[0]!.variables.values)).toEqual({ lat: '37.338163', lng: '-121.886220' });
  });
});
