import { describe, it, expect, vi } from 'vitest';
import { syncAllSources } from './sync';
import type { EventStore } from './db/events';
import type { CommitteeCalendarsConfig, LegistarSourceConfig, NormalizedEvent } from './types';

function fakeEventStore(): EventStore & {
  replaced: Array<{ sourceId: string; count: number; todayUtc: string }>;
  successes: string[];
  failures: Array<{ sourceId: string; message: string }>;
} {
  const replaced: Array<{ sourceId: string; count: number; todayUtc: string }> = [];
  const successes: string[] = [];
  const failures: Array<{ sourceId: string; message: string }> = [];
  const failureCounts = new Map<string, number>();

  return {
    replaced,
    successes,
    failures,
    async replaceSourceEvents(sourceId, events, todayUtc) {
      replaced.push({ sourceId, count: events.length, todayUtc });
    },
    async recordSourceSuccess(sourceId) {
      successes.push(sourceId);
      failureCounts.set(sourceId, 0);
    },
    async recordSourceFailure(sourceId, message) {
      failures.push({ sourceId, message });
      const next = (failureCounts.get(sourceId) ?? 0) + 1;
      failureCounts.set(sourceId, next);
      return next;
    },
    async getFutureEvents() {
      return [];
    },
  };
}

const SOURCE_A: LegistarSourceConfig = {
  id: 'a',
  name: 'Source A',
  committeeName: 'Committee A',
  adapter: 'legistar',
  client: 'a',
  bodyId: 1,
};
const SOURCE_B: LegistarSourceConfig = {
  id: 'b',
  name: 'Source B',
  committeeName: 'Committee B',
  adapter: 'legistar',
  client: 'b',
  bodyId: 2,
};

const CONFIG: CommitteeCalendarsConfig = { sources: [SOURCE_A, SOURCE_B] };
const NOW = new Date('2026-08-22T00:00:00.000Z');

describe('syncAllSources', () => {
  it('writes each successful source\'s events and records success', async () => {
    const eventStore = fakeEventStore();
    const events: NormalizedEvent[] = [
      { sourceId: 'a', externalId: '1', title: 't', committeeName: 'c', startUtc: NOW.toISOString(), endUtc: null, location: null, url: null },
    ];
    const fetchSourceEvents = vi.fn(async (source) => (source.id === 'a' ? events : []));

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(eventStore.replaced).toEqual([
      { sourceId: 'a', count: 1, todayUtc: NOW.toISOString() },
      { sourceId: 'b', count: 0, todayUtc: NOW.toISOString() },
    ]);
    expect(eventStore.successes).toEqual(['a', 'b']);
    expect(eventStore.failures).toEqual([]);
  });

  it('isolates one source\'s failure — the other source still syncs', async () => {
    const eventStore = fakeEventStore();
    const fetchSourceEvents = vi.fn(async (source) => {
      if (source.id === 'a') {
        throw new Error('a is down');
      }
      return [];
    });

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(eventStore.failures).toEqual([{ sourceId: 'a', message: 'a is down' }]);
    expect(eventStore.successes).toEqual(['b']);
    expect(eventStore.replaced).toEqual([{ sourceId: 'b', count: 0, todayUtc: NOW.toISOString() }]);
  });

  it('fires exactly one Slack alert the moment a source first reaches 3 consecutive failures', async () => {
    const eventStore = fakeEventStore();
    // Fail 'a' twice already before this run starts.
    await eventStore.recordSourceFailure('a', 'first');
    await eventStore.recordSourceFailure('a', 'second');

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const fetchSourceEvents = vi.fn(async (source) => {
      if (source.id === 'a') {
        throw new Error('third failure');
      }
      return [];
    });

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(fetchMock).toHaveBeenCalledTimes(1); // the Slack webhook POST
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://hooks.example');

    vi.unstubAllGlobals();
  });

  it('does not re-alert on a 4th consecutive failure', async () => {
    const eventStore = fakeEventStore();
    await eventStore.recordSourceFailure('a', 'first');
    await eventStore.recordSourceFailure('a', 'second');
    await eventStore.recordSourceFailure('a', 'third');

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const fetchSourceEvents = vi.fn(async (source) => {
      if (source.id === 'a') {
        throw new Error('fourth failure');
      }
      return [];
    });

    await syncAllSources({ eventStore, config: CONFIG, slackWebhookUrl: 'https://hooks.example', now: NOW, fetchSourceEvents });

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
