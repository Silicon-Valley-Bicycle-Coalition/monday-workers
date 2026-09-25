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
