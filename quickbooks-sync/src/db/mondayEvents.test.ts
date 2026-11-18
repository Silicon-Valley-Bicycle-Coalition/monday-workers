import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MondayEventStore } from './mondayEvents';

describe('D1MondayEventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1MondayEventStore(env.DB);
    const result = await store.insertEvent({
      eventId: 'item-1',
      mondayItemId: 'item-1',
      rawPayload: '{"text_col":"Acme"}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(result).toBe('inserted');

    const row = await store.getEvent('item-1');
    expect(row).toEqual({
      eventId: 'item-1',
      mondayItemId: 'item-1',
      rawPayload: '{"text_col":"Acme"}',
      status: 'received',
      qbId: null,
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
      createAttempt: 0,
      createSends: 0,
    });
  });

  it('reports duplicate on a second insert with the same event id', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({
      eventId: 'item-2',
      mondayItemId: 'item-2',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    const second = await store.insertEvent({
      eventId: 'item-2',
      mondayItemId: 'item-2',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:01.000Z',
    });
    expect(second).toBe('duplicate');
  });

  it('updates status and records the new QuickBooks id once created', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({
      eventId: 'item-3',
      mondayItemId: 'item-3',
      rawPayload: '{}',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });

    await store.updateStatus('item-3', 'failed', { error: 'boom' });
    let row = await store.getEvent('item-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('item-3', 'written', { qbId: 'qb-99', writtenAt: '2026-08-22T01:00:00.000Z' });
    row = await store.getEvent('item-3');
    expect(row?.status).toBe('written');
    expect(row?.qbId).toBe('qb-99');
    expect(row?.writtenAt).toBe('2026-08-22T01:00:00.000Z');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1MondayEventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });

  it('counts terminal create failures, so a redrive uses a fresh requestid', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({ eventId: 'item-10', mondayItemId: 'item-10', rawPayload: '{}', receivedAt: '2026-09-25T00:00:00.000Z' });
    expect((await store.getEvent('item-10'))?.createAttempt).toBe(0);

    await store.updateStatus('item-10', 'failed', { error: 'transient' });
    expect((await store.getEvent('item-10'))?.createAttempt).toBe(0);
    await store.updateStatus('item-10', 'failed', { error: 'not retried: duplicate name', bumpCreateAttempt: true });
    await store.updateStatus('item-10', 'failed', { error: 'not retried: duplicate name', bumpCreateAttempt: true });
    expect((await store.getEvent('item-10'))?.createAttempt).toBe(2);
  });

  it('counts creates sent under the current requestid, reset when the requestid advances', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({ eventId: 'item-11', mondayItemId: 'item-11', rawPayload: '{}', receivedAt: '2026-09-25T00:00:00.000Z' });
    expect((await store.getEvent('item-11'))?.createSends).toBe(0);

    await store.markCreateSent('item-11');
    await store.markCreateSent('item-11');
    expect((await store.getEvent('item-11'))?.createSends).toBe(2);

    await store.updateStatus('item-11', 'failed', { error: 'not retried: x', bumpCreateAttempt: true });
    const row = await store.getEvent('item-11');
    expect(row?.createSends).toBe(0);
    expect(row?.createAttempt).toBe(1);
  });

  // GL#33 review: the QuickBooks -> Monday path uses this to recognize a Customer that a Monday item
  // created, before that item's mapping is written, instead of creating a second Monday item.
  it('finds the row that created a given QuickBooks Customer', async () => {
    const store = new D1MondayEventStore(env.DB);
    await store.insertEvent({ eventId: 'item-9', mondayItemId: 'item-9', rawPayload: '{}', receivedAt: '2026-09-25T00:00:00.000Z' });
    await store.updateStatus('item-9', 'fetched', { qbId: 'qb-from-monday' });

    expect((await store.findByQbId('qb-from-monday'))?.mondayItemId).toBe('item-9');
    expect(await store.findByQbId('qb-unknown')).toBeNull();
  });
});
