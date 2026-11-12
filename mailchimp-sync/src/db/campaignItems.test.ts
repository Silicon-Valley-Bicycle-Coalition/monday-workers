import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1CampaignItemsStore } from './campaignItems';

async function one(store: D1CampaignItemsStore, interestId: string) {
  return (await store.getByInterestIds([interestId])).get(interestId) ?? null;
}

describe('D1CampaignItemsStore', () => {
  it('upsert then getByInterestIds round-trips', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null });

    expect(await one(store, 'int1')).toEqual({
      interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null,
    });
  });

  it('getByInterestIds leaves out an untracked interest', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    expect(await one(store, 'nope')).toBeNull();
  });

  // #97: the inbound consumer resolves a whole batch's interests with one query.
  it('getByInterestIds resolves many interests in one call, leaving out the untracked', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'm1', mondayItemId: 'item-m1', name: 'A', archivedAt: null });
    await store.upsert({ interestId: 'm2', mondayItemId: 'item-m2', name: 'B', archivedAt: null });
    const rows = await store.getByInterestIds(['m1', 'm2', 'nope', 'm1']);
    expect([...rows.keys()].sort()).toEqual(['m1', 'm2']);
    expect(rows.get('m2')).toEqual({ interestId: 'm2', mondayItemId: 'item-m2', name: 'B', archivedAt: null });
  });

  it('getByInterestIds returns an empty map for no ids, and handles more ids than one statement binds', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    expect((await store.getByInterestIds([])).size).toBe(0);
    await store.upsert({ interestId: 'bulk-149', mondayItemId: 'item-bulk', name: 'Bulk', archivedAt: null });
    const ids = Array.from({ length: 150 }, (_, i) => `bulk-${i}`);
    expect([...(await store.getByInterestIds(ids)).keys()]).toEqual(['bulk-149']);
  });

  it('upsert on an existing interest_id updates name/monday_item_id in place', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int2', mondayItemId: 'item2', name: 'Old Name', archivedAt: null });
    await store.upsert({ interestId: 'int2', mondayItemId: 'item2', name: 'New Name', archivedAt: null });

    expect(await one(store, 'int2')).toEqual({
      interestId: 'int2', mondayItemId: 'item2', name: 'New Name', archivedAt: null,
    });
  });

  it('listActive excludes archived rows', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int3', mondayItemId: 'item3', name: 'Active One', archivedAt: null });
    await store.upsert({ interestId: 'int4', mondayItemId: 'item4', name: 'Archived One', archivedAt: null });
    await store.markArchived('int4', '2026-08-26T00:00:00.000Z');

    const active = await store.listActive();
    expect(active.map((r) => r.interestId)).toContain('int3');
    expect(active.map((r) => r.interestId)).not.toContain('int4');
  });

  it('markArchived sets archived_at on the tracked row', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int5', mondayItemId: 'item5', name: 'X', archivedAt: null });
    await store.markArchived('int5', '2026-08-26T00:00:00.000Z');

    expect(await one(store, 'int5')).toEqual({
      interestId: 'int5', mondayItemId: 'item5', name: 'X', archivedAt: '2026-08-26T00:00:00.000Z',
    });
  });

  describe('claim (one creator per new interest, issue #28)', () => {
    const NOW = '2026-09-23T12:00:00.000Z';
    const STALE_BEFORE = '2026-09-23T11:50:00.000Z';

    it('lets exactly one of two concurrent claimants win an untracked interest', async () => {
      const store = new D1CampaignItemsStore(env.DB);
      const [a, b] = await Promise.all([
        store.claim('c1', 'Newsletter', NOW, STALE_BEFORE),
        store.claim('c1', 'Newsletter', NOW, STALE_BEFORE),
      ]);
      expect([a, b].sort()).toEqual([false, true]);
    });

    it('hides a claimed-but-not-yet-created row from listActive and getByInterestIds', async () => {
      const store = new D1CampaignItemsStore(env.DB);
      await store.claim('c2', 'Newsletter', NOW, STALE_BEFORE);
      expect((await store.listActive()).map((r) => r.interestId)).not.toContain('c2');
      expect(await one(store, 'c2')).toBeNull();
    });

    it('lets a stale claim (claimant crashed before creating) be reclaimed', async () => {
      const store = new D1CampaignItemsStore(env.DB);
      await store.claim('c3', 'Newsletter', '2026-09-23T11:00:00.000Z', '2026-09-23T10:50:00.000Z');
      expect(await store.claim('c3', 'Newsletter', NOW, STALE_BEFORE)).toBe(true);
    });

    it('refuses to claim an interest that already has a live Monday item', async () => {
      const store = new D1CampaignItemsStore(env.DB);
      await store.upsert({ interestId: 'c4', mondayItemId: 'item-c4', name: 'Newsletter', archivedAt: null });
      expect(await store.claim('c4', 'Newsletter', NOW, STALE_BEFORE)).toBe(false);
      expect(await one(store, 'c4')).toEqual({ interestId: 'c4', mondayItemId: 'item-c4', name: 'Newsletter', archivedAt: null });
    });

    it('allows claiming an archived interest that reappears in Mailchimp', async () => {
      const store = new D1CampaignItemsStore(env.DB);
      await store.upsert({ interestId: 'c5', mondayItemId: 'item-c5', name: 'Newsletter', archivedAt: null });
      await store.markArchived('c5', '2026-09-01T00:00:00.000Z');
      expect(await store.claim('c5', 'Newsletter', NOW, STALE_BEFORE)).toBe(true);
    });
  });
});
