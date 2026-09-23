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

  // Fix 3 (owner coalescing) needs to know whether a donation's link pre-dates an owner's last
  // recompute, so an unchanged re-assertion must keep its stored updated_at — and, in the spirit
  // of fix 2, cost no write.
  it('upsertLink reports an unchanged link as unchanged and keeps its stored updated_at', async () => {
    const store = new D1DonationLinksStore(env.DB);
    const link = { donationItemId: 'd-same', donationBoardId: '1', ownerItemId: 'o-same', ownerBoardId: '2' };
    expect(await store.upsertLink(link, '2026-01-01T00:00:00Z')).toEqual({ changed: true, updatedAt: '2026-01-01T00:00:00Z' });

    expect(await store.upsertLink(link, '2026-01-05T00:00:00Z')).toEqual({ changed: false, updatedAt: '2026-01-01T00:00:00Z' });
    const row = await env.DB.prepare(`SELECT updated_at FROM donation_links WHERE donation_item_id = 'd-same'`).first();
    expect(row).toEqual({ updated_at: '2026-01-01T00:00:00Z' });
  });

  it('upsertLink reports a re-owned link as changed and stamps the new updated_at', async () => {
    const store = new D1DonationLinksStore(env.DB);
    await store.upsertLink({ donationItemId: 'd-move', donationBoardId: '1', ownerItemId: 'o-old', ownerBoardId: '2' }, '2026-01-01T00:00:00Z');

    const result = await store.upsertLink({ donationItemId: 'd-move', donationBoardId: '1', ownerItemId: 'o-new', ownerBoardId: '3' }, '2026-01-05T00:00:00Z');

    // The owner it left comes back too — it must be recomputed (issue #26).
    expect(result).toEqual({ changed: true, updatedAt: '2026-01-05T00:00:00Z',
      previousOwner: { ownerItemId: 'o-old', ownerBoardId: '2' } });
    expect(await store.getLinkForDonation('d-move')).toEqual({ ownerItemId: 'o-new', ownerBoardId: '3' });
  });

  it('upsertLink reports no previousOwner for a new link or a board-only change', async () => {
    const store = new D1DonationLinksStore(env.DB);
    expect(await store.upsertLink({ donationItemId: 'd-new', donationBoardId: '1', ownerItemId: 'o1', ownerBoardId: '2' }, '2026-01-01T00:00:00Z'))
      .toEqual({ changed: true, updatedAt: '2026-01-01T00:00:00Z' });
    expect(await store.upsertLink({ donationItemId: 'd-new', donationBoardId: '9', ownerItemId: 'o1', ownerBoardId: '2' }, '2026-01-02T00:00:00Z'))
      .toEqual({ changed: true, updatedAt: '2026-01-02T00:00:00Z' });
  });

  it('deleteLink drops a donation from its owner\'s reverse index', async () => {
    const store = new D1DonationLinksStore(env.DB);
    await store.upsertLink({ donationItemId: 'd-del', donationBoardId: '1', ownerItemId: 'o-del', ownerBoardId: '2' }, '2026-01-01T00:00:00Z');
    await store.deleteLink('d-del');
    expect(await store.getLinkForDonation('d-del')).toBeNull();
    expect((await store.getLinksForOwner('o-del')).size).toBe(0);
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

  it('looks up the stored owner for one donation, null when unknown', async () => {
    const store = new D1DonationLinksStore(env.DB);
    await store.upsertLink({ donationItemId: 'd9', donationBoardId: '1', ownerItemId: 'o9', ownerBoardId: '2' }, '2026-01-01T00:00:00Z');
    expect(await store.getLinkForDonation('d9')).toEqual({ ownerItemId: 'o9', ownerBoardId: '2' });
    expect(await store.getLinkForDonation('never-seen')).toBeNull();
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
