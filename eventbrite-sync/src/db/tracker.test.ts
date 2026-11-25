import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1TrackerStore } from './tracker';

const T0 = '2026-11-24T00:00:00.000Z';

describe('D1TrackerStore', () => {
  it('saves, replaces, lists and deletes what it wrote to a tracker row', async () => {
    const store = new D1TrackerStore(env.DB);
    await store.saveCounts({ trackerItemId: 'r-1', eventItemId: 'e-1', date: '2026-11-14', totals: { registered: 5, checkedIn: 1, noShows: 3 } }, T0);
    await store.saveCounts({ trackerItemId: 'r-2', eventItemId: 'e-2', date: '2026-11-15', totals: { registered: 2, checkedIn: 2, noShows: 0 } }, T0);
    await store.saveCounts({ trackerItemId: 'r-1', eventItemId: 'e-3', date: '2026-11-16', totals: { registered: 6, checkedIn: 2, noShows: 1 } }, T0);
    const all = await store.listCounts();
    expect(all.get('r-1')).toEqual({ trackerItemId: 'r-1', eventItemId: 'e-3', date: '2026-11-16', totals: { registered: 6, checkedIn: 2, noShows: 1 } });
    expect(all.get('r-2')).toEqual({ trackerItemId: 'r-2', eventItemId: 'e-2', date: '2026-11-15', totals: { registered: 2, checkedIn: 2, noShows: 0 } });

    await store.deleteCounts('r-1');
    expect([...(await store.listCounts()).keys()]).toEqual(['r-2']);
  });

  it('saves, replaces, lists and deletes what it wrote as an event’s Grant', async () => {
    const store = new D1TrackerStore(env.DB);
    await store.saveGrant('g-1', { grant: 'VTA', trackerItemId: 'r-1' }, T0);
    await store.saveGrant('g-2', { grant: 'SMCTA', trackerItemId: 'r-2' }, T0);
    await store.saveGrant('g-1', { grant: 'SMCTA', trackerItemId: 'r-3' }, T0);
    expect(await store.listGrants()).toEqual(new Map([['g-1', { grant: 'SMCTA', trackerItemId: 'r-3' }], ['g-2', { grant: 'SMCTA', trackerItemId: 'r-2' }]]));

    await store.deleteGrant('g-1');
    expect(await store.listGrants()).toEqual(new Map([['g-2', { grant: 'SMCTA', trackerItemId: 'r-2' }]]));
  });
});
