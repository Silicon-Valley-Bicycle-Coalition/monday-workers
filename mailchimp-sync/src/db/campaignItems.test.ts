import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1CampaignItemsStore } from './campaignItems';

describe('D1CampaignItemsStore', () => {
  it('upsert then getByInterestId round-trips', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null });

    expect(await store.getByInterestId('int1')).toEqual({
      interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null,
    });
  });

  it('getByInterestId returns null for an untracked interest', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    expect(await store.getByInterestId('nope')).toBeNull();
  });

  it('upsert on an existing interest_id updates name/monday_item_id in place', async () => {
    const store = new D1CampaignItemsStore(env.DB);
    await store.upsert({ interestId: 'int2', mondayItemId: 'item2', name: 'Old Name', archivedAt: null });
    await store.upsert({ interestId: 'int2', mondayItemId: 'item2', name: 'New Name', archivedAt: null });

    expect(await store.getByInterestId('int2')).toEqual({
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

    expect(await store.getByInterestId('int5')).toEqual({
      interestId: 'int5', mondayItemId: 'item5', name: 'X', archivedAt: '2026-08-26T00:00:00.000Z',
    });
  });
});
