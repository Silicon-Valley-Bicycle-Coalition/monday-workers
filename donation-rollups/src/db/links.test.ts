import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1DonationLinksStore } from './links';

describe('D1DonationLinksStore', () => {
  it('upserts a link, then updates it on redelivery instead of duplicating', async () => {
    const store = new D1DonationLinksStore(env.DB);
    await store.upsertLink({ donationItemId: 'd1', donationBoardId: '1', ownerItemId: 'o1', ownerBoardId: '2' }, '2026-01-01T00:00:00Z');
    await store.upsertLink({ donationItemId: 'd1', donationBoardId: '1', ownerItemId: 'o1', ownerBoardId: '2' }, '2026-01-02T00:00:00Z');

    const links = await store.getLinksForOwner('o1');
    expect(links.get('1')).toEqual(['d1']);
  });

  it('groups multiple donations for one owner by their donation board id', async () => {
    const store = new D1DonationLinksStore(env.DB);
    await store.upsertLink({ donationItemId: 'd1', donationBoardId: '1', ownerItemId: 'o2', ownerBoardId: '2' }, '2026-01-01T00:00:00Z');
    await store.upsertLink({ donationItemId: 'd2', donationBoardId: '1', ownerItemId: 'o2', ownerBoardId: '2' }, '2026-01-01T00:00:00Z');
    await store.upsertLink({ donationItemId: 'd3', donationBoardId: '9', ownerItemId: 'o2', ownerBoardId: '2' }, '2026-01-01T00:00:00Z');

    const links = await store.getLinksForOwner('o2');
    expect(new Set(links.get('1'))).toEqual(new Set(['d1', 'd2']));
    expect(links.get('9')).toEqual(['d3']);
  });

  it('returns an empty map for an owner with no known links', async () => {
    const store = new D1DonationLinksStore(env.DB);
    expect((await store.getLinksForOwner('nope')).size).toBe(0);
  });

  it('bulk-upserts in batches, reporting the total row count written', async () => {
    const store = new D1DonationLinksStore(env.DB);
    const rows = Array.from({ length: 250 }, (_, i) => ({
      donationItemId: `bulk-${i}`, donationBoardId: '1', ownerItemId: 'o3', ownerBoardId: '2', updatedAt: '2026-01-01T00:00:00Z',
    }));
    const written = await store.bulkUpsert(rows);
    expect(written).toBe(250);
    expect((await store.getLinksForOwner('o3')).get('1')).toHaveLength(250);
  });
});
