import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1QbEventStore } from './qbEvents';

describe('D1QbEventStore', () => {
  it('inserts a new event and reads it back', async () => {
    const store = new D1QbEventStore(env.DB);
    const result = await store.recordEvents([{
      eventId: 'evt-1',
      entityType: 'customer',
      qbId: 'qb-1',
      receivedAt: '2026-08-22T00:00:00.000Z',
    }]);
    expect(result).toEqual([{ inserted: true }]);

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
    await store.recordEvents([{
      eventId: 'evt-2',
      entityType: 'customer',
      qbId: 'qb-2',
      receivedAt: '2026-08-22T00:00:00.000Z',
    }]);
    const second = await store.recordEvents([{
      eventId: 'evt-2',
      entityType: 'customer',
      qbId: 'qb-2',
      receivedAt: '2026-08-22T00:00:01.000Z',
    }]);
    expect(second).toEqual([{ inserted: false, status: 'received' }]);
  });

  it('updates status and patch fields, then clears error on the next update', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.recordEvents([{
      eventId: 'evt-3',
      entityType: 'invoice',
      qbId: 'qb-3',
      receivedAt: '2026-08-22T00:00:00.000Z',
    }]);

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

  // #101: a whole webhook delivery is recorded in one round trip.
  it('records a mix of new and redelivered rows, reporting each in input order', async () => {
    const store = new D1QbEventStore(env.DB);
    const row = (eventId: string) => ({ eventId, entityType: 'customer' as const, qbId: eventId, receivedAt: '2026-08-22T00:00:00.000Z' });
    await store.recordEvents([row('mix-queued'), row('mix-failed')]);
    await store.markEvents(['mix-queued'], 'queued');
    await store.markEvents(['mix-failed'], 'failed', 'queue unavailable');

    const results = await store.recordEvents([row('mix-new'), row('mix-queued'), row('mix-failed')]);

    expect(results).toEqual([
      { inserted: true },
      { inserted: false, status: 'queued' },
      { inserted: false, status: 'failed' },
    ]);
  });

  it('records more rows than one statement can bind', async () => {
    const store = new D1QbEventStore(env.DB);
    const rows = Array.from({ length: 205 }, (_, i) => ({ eventId: `bulk-${i}`, entityType: 'invoice' as const, qbId: `${i}`, receivedAt: '2026-08-22T00:00:00.000Z' }));

    expect((await store.recordEvents(rows)).every((r) => r.inserted)).toBe(true);
    await store.markEvents(rows.map((r) => r.eventId), 'queued');

    expect((await store.getEvent('bulk-0'))?.status).toBe('queued');
    expect((await store.getEvent('bulk-204'))?.status).toBe('queued');
    expect((await store.recordEvents(rows)).every((r) => !r.inserted && r.status === 'queued')).toBe(true);
  });

  it('markEvents sets the error, then clears it when omitted', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.recordEvents([{ eventId: 'mark-1', entityType: 'customer', qbId: 'm1', receivedAt: '2026-08-22T00:00:00.000Z' }]);
    await store.markEvents(['mark-1'], 'failed', 'boom');
    expect(await store.getEvent('mark-1')).toMatchObject({ status: 'failed', error: 'boom' });
    await store.markEvents(['mark-1'], 'queued');
    expect(await store.getEvent('mark-1')).toMatchObject({ status: 'queued', error: null });
  });

  it('returns null for an unknown event id', async () => {
    const store = new D1QbEventStore(env.DB);
    expect(await store.getEvent('does-not-exist')).toBeNull();
  });

  it('round-trips pendingMondayItemId and leaves status untouched when only that field is patched', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.recordEvents([{
      eventId: 'evt-4',
      entityType: 'customer',
      qbId: 'qb-4',
      receivedAt: '2026-08-22T00:00:00.000Z',
    }]);
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
describe('D1QbEventStore create-loop lookup', () => {
  const since = '2026-09-25T00:00:00.000Z';

  it('finds the row that created a Monday item by its recorded item id', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.recordEvents([{ eventId: 'claim-2', entityType: 'customer', qbId: 'qb-c2', receivedAt: since }]);
    await store.updateStatus('claim-2', 'failed', { pendingMondayItemId: 'item-c2', error: 'mapping write failed' });

    expect((await store.findByPendingMondayItemId('customer', 'item-c2'))?.qbId).toBe('qb-c2');
    expect(await store.findByPendingMondayItemId('customer', 'item-nope')).toBeNull();
    expect(await store.findByPendingMondayItemId('invoice', 'item-c2')).toBeNull();
  });
});
