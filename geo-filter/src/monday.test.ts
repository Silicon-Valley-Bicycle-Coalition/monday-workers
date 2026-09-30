import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchContacts } from './monday.js';

const COLUMNS = [
  { id: 'name', title: 'Donor' },
  { id: 'lat_1', title: 'Lat' },
  { id: 'lng_1', title: 'Lng' },
  { id: 'zip_1', title: 'Zip' },
  { id: 'text_full', title: 'Full Name' },
];

const ITEM = {
  id: '101',
  name: 'Item Name',
  column_values: [
    { id: 'lat_1', text: '37.33' },
    { id: 'lng_1', text: '-121.9' },
    { id: 'zip_1', text: '95113' },
    { id: 'text_full', text: 'Ada Lovelace' },
  ],
};

// Stubs Monday's API: the first call is the columns lookup, the second a single items page.
function stubMonday(item = ITEM) {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const data = body.query.includes('items_page')
      ? { boards: [{ items_page: { cursor: null, items: [item] } }] }
      : { boards: [{ columns: COLUMNS }] };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }));
  return bodies;
}

const base = { lat: 'Lat', lng: 'Lng', zip: 'Zip' };

describe('fetchContacts name column', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the item name by default, even when the board has renamed that column', async () => {
    const bodies = stubMonday();
    const [contact] = await fetchContacts('t', '1', base);
    expect(contact?.name).toBe('Item Name');
    expect(bodies[1]?.variables.colIds).toEqual(['lat_1', 'lng_1', 'zip_1']);
  });

  it('reads --name-column from the named column when it is set', async () => {
    const bodies = stubMonday();
    const [contact] = await fetchContacts('t', '1', { ...base, name: 'Full Name' });
    expect(contact?.name).toBe('Ada Lovelace');
    expect(bodies[1]?.variables.colIds).toEqual(['lat_1', 'lng_1', 'zip_1', 'text_full']);
  });

  it('accepts the item-name column by its title', async () => {
    stubMonday();
    const [contact] = await fetchContacts('t', '1', { ...base, name: 'Donor' });
    expect(contact?.name).toBe('Item Name');
  });

  it('falls back to the item name when the named column is blank', async () => {
    stubMonday({ ...ITEM, column_values: ITEM.column_values.map((cv) => (cv.id === 'text_full' ? { ...cv, text: '' } : cv)) });
    const [contact] = await fetchContacts('t', '1', { ...base, name: 'Full Name' });
    expect(contact?.name).toBe('Item Name');
  });

  it('errors when --name-column names a column the board does not have', async () => {
    stubMonday();
    await expect(fetchContacts('t', '1', { ...base, name: 'Nickname' })).rejects.toThrow('name column "Nickname"');
  });
});

// #35: requests go through the canonical transport (monday/graphql.ts).
describe('fetchContacts transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rides out a rate limit mid page-through instead of aborting the run', async () => {
    let itemsCalls = 0;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (!body.query.includes('items_page')) return Response.json({ data: { boards: [{ columns: COLUMNS }] } });
      itemsCalls++;
      if (itemsCalls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
      return Response.json({ data: { boards: [{ items_page: { cursor: null, items: [ITEM] } }] } });
    });
    const contacts = await fetchContacts('t', '1', base, { fetchFn: fetchFn as typeof fetch, sleepFn: async () => {} });
    expect(contacts).toHaveLength(1);
    expect(itemsCalls).toBe(2);
  });

  it('pins API-Version 2026-01', async () => {
    stubMonday();
    await fetchContacts('t', '1', base);
    const init = (vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('API-Version')).toBe('2026-01');
  });
});
