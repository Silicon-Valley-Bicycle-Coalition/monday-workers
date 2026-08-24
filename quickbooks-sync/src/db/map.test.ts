import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MapStore } from './map';

describe('D1MapStore', () => {
  it('creates a mapping and reads it back by qbId and by mondayItemId', async () => {
    const store = new D1MapStore(env.DB);
    await store.createMapping({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-1',
      mondayBoardId: 111,
      createdAt: '2026-08-22T00:00:00.000Z',
    });

    const byQbId = await store.getByQbId('customer', 'qb-1');
    expect(byQbId).toEqual({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-1',
      mondayBoardId: 111,
      createdAt: '2026-08-22T00:00:00.000Z',
    });

    const byMondayItemId = await store.getByMondayItemId('customer', 'item-1');
    expect(byMondayItemId).toEqual(byQbId);
  });

  it('returns null for an unknown qbId or mondayItemId', async () => {
    const store = new D1MapStore(env.DB);
    expect(await store.getByQbId('customer', 'does-not-exist')).toBeNull();
    expect(await store.getByMondayItemId('customer', 'does-not-exist')).toBeNull();
  });

  it('does not cross-match entity types sharing the same id', async () => {
    const store = new D1MapStore(env.DB);
    await store.createMapping({
      entityType: 'customer',
      qbId: 'shared-id',
      mondayItemId: 'item-a',
      mondayBoardId: 1,
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    expect(await store.getByQbId('invoice', 'shared-id')).toBeNull();
  });

  it('reports a clear error when a monday_item_id is claimed by a second qb_id', async () => {
    const store = new D1MapStore(env.DB);
    await store.createMapping({
      entityType: 'customer',
      qbId: 'qb-first',
      mondayItemId: 'contested-item',
      mondayBoardId: 1,
      createdAt: '2026-08-22T00:00:00.000Z',
    });

    // Trips the (entity_type, monday_item_id) unique index, which the upsert's ON CONFLICT
    // clause does not cover — the raw SQLite error is translated into a named one.
    await expect(
      store.createMapping({
        entityType: 'customer',
        qbId: 'qb-second',
        mondayItemId: 'contested-item',
        mondayBoardId: 1,
        createdAt: '2026-08-22T01:00:00.000Z',
      })
    ).rejects.toThrow(
      'qb_monday_map: monday_item_id "contested-item" is already mapped to a different qb_id for entity type "customer"'
    );
  });

  it('upserts on a second createMapping call for the same entityType/qbId', async () => {
    const store = new D1MapStore(env.DB);
    await store.createMapping({
      entityType: 'product',
      qbId: 'qb-2',
      mondayItemId: 'item-2',
      mondayBoardId: 1,
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    await store.createMapping({
      entityType: 'product',
      qbId: 'qb-2',
      mondayItemId: 'item-2-moved',
      mondayBoardId: 2,
      createdAt: '2026-08-22T01:00:00.000Z',
    });

    const result = await store.getByQbId('product', 'qb-2');
    expect(result?.mondayItemId).toBe('item-2-moved');
    expect(result?.mondayBoardId).toBe(2);
  });
});
