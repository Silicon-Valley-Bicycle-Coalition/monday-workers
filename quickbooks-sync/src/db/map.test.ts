import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MapStore, MappingConflictError } from './map';
import { isTerminalError } from '../errors';

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

  it('is idempotent for the same entityType/qbId/item', async () => {
    const store = new D1MapStore(env.DB);
    const entry = { entityType: 'product' as const, qbId: 'qb-2', mondayItemId: 'item-2', mondayBoardId: 1, createdAt: '2026-08-22T00:00:00.000Z' };
    await store.createMapping(entry);
    await expect(store.createMapping({ ...entry, createdAt: '2026-08-22T01:00:00.000Z' })).resolves.toBeUndefined();
    expect((await store.getByQbId('product', 'qb-2'))?.mondayItemId).toBe('item-2');
  });

  // #33 review: this was an upsert, so a second item claiming a QuickBooks record silently
  // re-pointed its mapping. It now refuses, naming both items; only repointMapping moves it.
  it('refuses to re-point a record already mapped to another item, as a terminal conflict', async () => {
    const store = new D1MapStore(env.DB);
    const entry = { entityType: 'customer' as const, qbId: 'qb-c', mondayItemId: 'item-b', mondayBoardId: 1, createdAt: '2026-08-22T00:00:00.000Z' };
    await store.createMapping(entry);

    const err = await store.createMapping({ ...entry, mondayItemId: 'item-a' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MappingConflictError);
    expect(isTerminalError(err)).toBe(true);
    expect((err as MappingConflictError).existingMondayItemId).toBe('item-b');
    expect((err as Error).message).toMatch(/QuickBooks customer qb-c already has Monday item "item-b".*item "item-a"/);
    expect((await store.getByQbId('customer', 'qb-c'))?.mondayItemId).toBe('item-b');
  });

  it('repointMapping moves a record to another item deliberately', async () => {
    const store = new D1MapStore(env.DB);
    const entry = { entityType: 'customer' as const, qbId: 'qb-d', mondayItemId: 'item-old', mondayBoardId: 1, createdAt: '2026-08-22T00:00:00.000Z' };
    await store.createMapping(entry);
    await store.repointMapping({ ...entry, mondayItemId: 'item-new', mondayBoardId: 2 });

    const result = await store.getByQbId('customer', 'qb-d');
    expect(result?.mondayItemId).toBe('item-new');
    expect(result?.mondayBoardId).toBe(2);
  });
});
