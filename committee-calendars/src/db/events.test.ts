import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from './events';
import type { NormalizedEvent } from '../types';

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'campbell',
    externalId: 'evt-1',
    title: 'BPAC Meeting',
    committeeName: 'Bicycle & Pedestrian Advisory Committee',
    startUtc: '2026-09-01T00:00:00.000Z',
    endUtc: '2026-09-01T01:00:00.000Z',
    location: 'Council Chamber',
    url: 'https://example.com/1',
    ...overrides,
  };
}

describe('D1EventStore', () => {
  it('replaceSourceEvents inserts events retrievable by getFutureEvents', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents('campbell', [event()], '2026-08-01T00:00:00.000Z');

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future).toEqual([event()]);
  });

  it('replaceSourceEvents drops a future event that stopped being returned (cancelled meeting)', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents(
      'campbell',
      [event({ externalId: 'evt-1' }), event({ externalId: 'evt-2', startUtc: '2026-09-15T00:00:00.000Z' })],
      '2026-08-01T00:00:00.000Z'
    );
    // Next day's poll no longer returns evt-2 (it was cancelled).
    await store.replaceSourceEvents('campbell', [event({ externalId: 'evt-1' })], '2026-08-02T00:00:00.000Z');

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future.map((e) => e.externalId)).toEqual(['evt-1']);
  });

  it('replaceSourceEvents never touches another source\'s events', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents('campbell', [event({ sourceId: 'campbell', externalId: 'c-1' })], '2026-08-01T00:00:00.000Z');
    await store.replaceSourceEvents('saratoga', [event({ sourceId: 'saratoga', externalId: 's-1' })], '2026-08-01T00:00:00.000Z');
    await store.replaceSourceEvents('campbell', [], '2026-08-02T00:00:00.000Z'); // campbell now has zero events

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future.map((e) => e.sourceId)).toEqual(['saratoga']);
  });

  it('getFutureEvents excludes events before the given instant and orders by start ascending', async () => {
    const store = new D1EventStore(env.DB);
    await store.replaceSourceEvents(
      'campbell',
      [
        event({ externalId: 'past', startUtc: '2026-01-01T00:00:00.000Z' }),
        event({ externalId: 'later', startUtc: '2026-10-01T00:00:00.000Z' }),
        event({ externalId: 'sooner', startUtc: '2026-09-01T00:00:00.000Z' }),
      ],
      '2025-12-01T00:00:00.000Z' // todayUtc predates all three so the delete step doesn't remove 'past'
    );

    const future = await store.getFutureEvents('2026-08-01T00:00:00.000Z');
    expect(future.map((e) => e.externalId)).toEqual(['sooner', 'later']);
  });

  it('recordSourceSuccess resets a failure streak', async () => {
    const store = new D1EventStore(env.DB);
    await store.recordSourceFailure('bart', 'boom');
    await store.recordSourceFailure('bart', 'boom again');
    await store.recordSourceSuccess('bart', '2026-08-01T00:00:00.000Z');

    const third = await store.recordSourceFailure('bart', 'boom a third time');
    expect(third).toBe(1); // streak reset by the intervening success
  });

  it('recordSourceFailure increments and returns the running consecutive_failures count', async () => {
    const store = new D1EventStore(env.DB);
    expect(await store.recordSourceFailure('bart', 'first')).toBe(1);
    expect(await store.recordSourceFailure('bart', 'second')).toBe(2);
    expect(await store.recordSourceFailure('bart', 'third')).toBe(3);
  });
});
