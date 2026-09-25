import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1QbEventStore } from './qbEvents';

describe('D1QbEventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1QbEventStore(env.DB);
    const result = await store.insertEvent({
      eventId: 'evt-1',
      entityType: 'customer',
      qbId: 'qb-1',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(result).toBe('inserted');

    const row = await store.getEvent('evt-1');
    expect(row).toEqual({
      eventId: 'evt-1',
      entityType: 'customer',
      qbId: 'qb-1',
      fetchedPayload: null,
      pendingMondayItemId: null,
      status: 'received',
      error: null,
      receivedAt: '2026-08-22T00:00:00.000Z',
      writtenAt: null,
    });
  });

  it('reports duplicate on a second insert with the same event id', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'customer',
      qbId: 'qb-2',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    const second = await store.insertEvent({
      eventId: 'evt-2',
      entityType: 'customer',
      qbId: 'qb-2',
      receivedAt: '2026-08-22T00:00:01.000Z',
    });
    expect(second).toBe('duplicate');
  });

  it('updates status and patch fields, then clears error on the next update', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-3',
      entityType: 'invoice',
      qbId: 'qb-3',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });

    await store.updateStatus('evt-3', 'failed', { error: 'boom' });
    let row = await store.getEvent('evt-3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');

    await store.updateStatus('evt-3', 'fetched', { fetchedPayload: '{"Id":"qb-3"}' });
    row = await store.getEvent('evt-3');
    expect(row?.status).toBe('fetched');
    expect(row?.fetchedPayload).toBe('{"Id":"qb-3"}');
    expect(row?.error).toBeNull();

    await store.updateStatus('evt-3', 'written', { writtenAt: '2026-08-22T01:00:00.000Z' });
    row = await store.getEvent('evt-3');
    expect(row?.status).toBe('written');
    expect(row?.writtenAt).toBe('2026-08-22T01:00:00.000Z');
    expect(row?.fetchedPayload).toBe('{"Id":"qb-3"}');
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1QbEventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });

  it('round-trips pendingMondayItemId and leaves status untouched when only that field is patched', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-4',
      entityType: 'customer',
      qbId: 'qb-4',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    await store.updateStatus('evt-4', 'queued');

    await store.updateStatus('evt-4', 'queued', { pendingMondayItemId: 'item-abc' });
    const row = await store.getEvent('evt-4');
    expect(row?.status).toBe('queued');
    expect(row?.pendingMondayItemId).toBe('item-abc');

    // A later patch that doesn't mention pendingMondayItemId must not clear it — same
    // COALESCE-on-write behavior the other patch fields already have.
    await store.updateStatus('evt-4', 'written', { writtenAt: '2026-08-22T01:00:00.000Z' });
    const finalRow = await store.getEvent('evt-4');
    expect(finalRow?.pendingMondayItemId).toBe('item-abc');
  });
});

// #33: the create-loop guard. The Monday side must be able to tell that an item it's about to
// turn into a QuickBooks Customer was itself created from QuickBooks.
describe('D1QbEventStore Monday-create claims', () => {
  const since = '2026-09-25T00:00:00.000Z';

  it('reports a customer create in flight from the claim until the item id is recorded', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({ eventId: 'claim-1', entityType: 'customer', qbId: 'qb-c1', receivedAt: since });
    expect(await store.hasMondayCreateInFlight('customer', since)).toBe(false);

    await store.markMondayCreateStarted('claim-1', '2026-09-25T00:05:00.000Z');
    expect(await store.hasMondayCreateInFlight('customer', since)).toBe(true);
    expect(await store.hasMondayCreateInFlight('invoice', since)).toBe(false);
    // A claim older than the cutoff (a writer that died before recording an id) stops blocking.
    expect(await store.hasMondayCreateInFlight('customer', '2026-09-25T00:06:00.000Z')).toBe(false);

    await store.updateStatus('claim-1', 'queued', { pendingMondayItemId: 'item-c1' });
    expect(await store.hasMondayCreateInFlight('customer', since)).toBe(false);
  });

  it('finds the row that created a Monday item by its recorded item id', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({ eventId: 'claim-2', entityType: 'customer', qbId: 'qb-c2', receivedAt: since });
    await store.updateStatus('claim-2', 'failed', { pendingMondayItemId: 'item-c2', error: 'mapping write failed' });

    expect((await store.findByPendingMondayItemId('customer', 'item-c2'))?.qbId).toBe('qb-c2');
    expect(await store.findByPendingMondayItemId('customer', 'item-nope')).toBeNull();
    expect(await store.findByPendingMondayItemId('invoice', 'item-c2')).toBeNull();
  });

  it('no longer reports a written row as in flight', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({ eventId: 'claim-3', entityType: 'customer', qbId: 'qb-c3', receivedAt: since });
    await store.markMondayCreateStarted('claim-3', '2026-09-25T00:05:00.000Z');
    await store.updateStatus('claim-3', 'written', { writtenAt: '2026-09-25T00:06:00.000Z' });
    expect(await store.hasMondayCreateInFlight('customer', since)).toBe(false);
  });
});
