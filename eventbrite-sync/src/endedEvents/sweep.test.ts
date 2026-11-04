import { describe, it, expect, vi, afterEach } from 'vitest';
import { sweepEndedEvents, type EndedEventSweepDeps } from './sweep';
import { dryRunEndedEventDeps } from '../writeSwitch';
import { fakeEventStore } from '../test/fakeStores';
import type { EventRow } from '../types';
import type { SkipContext } from '../flags';

const NOW = new Date('2026-11-03T15:00:00Z');
const ENDS = '2026-11-03T04:00:00.000Z';

function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: 'ev1', mondayItemId: 'item-1', startsAt: '2026-11-03T02:00:00.000Z', endsAt: ENDS, locationKey: 'x',
    eventbriteStatus: 'live', status: 'written', lastAction: 'event.updated', error: null, deliveries: 1,
    receivedAt: '2026-10-20T00:00:00.000Z', writtenAt: '2026-10-20T00:00:05.000Z', ...overrides,
  };
}

function deps(rows: EventRow[], send = vi.fn().mockResolvedValue(undefined)) {
  const eventStore = fakeEventStore({ listEndedBetween: vi.fn().mockResolvedValue(rows) });
  return { eventStore, queue: { send } } satisfies EndedEventSweepDeps;
}

describe('sweepEndedEvents', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the last 30 days of ended events', async () => {
    const d = deps([]);
    await sweepEndedEvents(NOW, d);
    expect(d.eventStore.listEndedBetween).toHaveBeenCalledWith('2026-10-04T15:00:00.000Z', '2026-11-03T15:00:00.000Z');
  });

  it.each(['live', 'started'])('re-drives a %s event last written before it ended', async (eventbriteStatus) => {
    const d = deps([row({ eventbriteStatus })]);
    expect(await sweepEndedEvents(NOW, d)).toEqual({ queued: ['ev1'], failed: [] });
    expect(d.eventStore.recordDelivery).toHaveBeenCalledWith({ eventId: 'ev1', action: 'event.ended', receivedAt: NOW.toISOString() });
    expect(d.queue.send).toHaveBeenCalledWith({ kind: 'event', eventId: 'ev1', action: 'event.ended' });
    expect(d.eventStore.updateStatus).toHaveBeenCalledWith('ev1', 'queued');
  });

  it('records the delivery before sending and marks it queued after', async () => {
    const d = deps([row()]);
    await sweepEndedEvents(NOW, d);
    const [recorded] = vi.mocked(d.eventStore.recordDelivery).mock.invocationCallOrder;
    const [sent] = d.queue.send.mock.invocationCallOrder;
    const [marked] = vi.mocked(d.eventStore.updateStatus).mock.invocationCallOrder;
    expect(recorded!).toBeLessThan(sent!);
    expect(sent!).toBeLessThan(marked!);
  });

  // The run-once guard: processEvent stamps written_at, so a re-driven event, or one a real
  // delivery reached after it ended, no longer qualifies.
  it('leaves an event already written after it ended', async () => {
    const d = deps([row({ writtenAt: '2026-11-03T04:00:01.000Z' })]);
    expect(await sweepEndedEvents(NOW, d)).toEqual({ queued: [], failed: [] });
    expect(d.queue.send).not.toHaveBeenCalled();
    expect(d.eventStore.recordDelivery).not.toHaveBeenCalled();
  });

  it.each(['completed', 'ended', 'canceled', 'deleted', 'draft'])('leaves an event last seen as %s', async (eventbriteStatus) => {
    const d = deps([row({ eventbriteStatus })]);
    expect(await sweepEndedEvents(NOW, d)).toEqual({ queued: [], failed: [] });
  });

  // `queued`/`received`: already on the way, so an hourly re-send would only pile up during an
  // outage. `failed`: waiting for a human (item deleted, event 404, dead-lettered).
  it.each(['received', 'queued', 'failed'] as const)('leaves a %s row', async (status) => {
    const d = deps([row({ status })]);
    expect(await sweepEndedEvents(NOW, d)).toEqual({ queued: [], failed: [] });
    expect(d.queue.send).not.toHaveBeenCalled();
  });

  it('leaves a row with no written_at or no end', async () => {
    const d = deps([row({ writtenAt: null }), row({ eventId: 'ev2', endsAt: null })]);
    expect(await sweepEndedEvents(NOW, d)).toEqual({ queued: [], failed: [] });
  });

  it('restores a row whose send failed, so the next hourly run retries it, and carries on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValueOnce(new Error('queue down')).mockResolvedValue(undefined);
    const d = deps([row(), row({ eventId: 'ev2' })], send);
    expect(await sweepEndedEvents(NOW, d)).toEqual({ queued: ['ev2'], failed: ['ev1'] });
    expect(d.eventStore.updateStatus).toHaveBeenCalledWith('ev1', 'written');
    expect(d.eventStore.updateStatus).toHaveBeenCalledWith('ev2', 'queued');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('queue down'));
  });

  it('reports a failed restore rather than rejecting the sweep', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps([row()], vi.fn().mockRejectedValue(new Error('queue down')));
    vi.mocked(d.eventStore.updateStatus).mockRejectedValue(new Error('D1 down'));
    expect(await sweepEndedEvents(NOW, d)).toEqual({ queued: [], failed: ['ev1'] });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('D1 down'));
  });
});

describe('sweepEndedEvents under a write-switch dry run', () => {
  const ctx: SkipContext = { worker: 'eventbrite-sync', environment: 'production', deliveryId: 'ended-events:t', mode: 'off', logLevel: 'normal', piiKeys: [] };

  it('logs the would-be send and changes neither the queue nor the ledger', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const live = deps([row()]);
    const result = await sweepEndedEvents(NOW, dryRunEndedEventDeps(live, ctx));
    expect(result).toEqual({ queued: ['ev1'], failed: [] });
    expect(live.queue.send).not.toHaveBeenCalled();
    expect(live.eventStore.recordDelivery).not.toHaveBeenCalled();
    expect(live.eventStore.updateStatus).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('Write queue');
    log.mockRestore();
  });
});
