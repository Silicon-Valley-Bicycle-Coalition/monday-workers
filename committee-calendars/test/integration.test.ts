import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1EventStore } from '../src/db/events';
import { syncAllSources } from '../src/sync';
import { createApp } from '../src/route';
import type { CommitteeCalendarsConfig, LegistarSourceConfig, NormalizedEvent } from '../src/types';

const SOURCE: LegistarSourceConfig = {
  id: 'test-source',
  name: 'Test Source',
  committeeName: 'Test Committee',
  adapter: 'legistar',
  client: 'test',
  bodyId: 1,
};
const CONFIG: CommitteeCalendarsConfig = { sources: [SOURCE] };

describe('committee-calendars integration', () => {
  it('serves an empty-but-valid calendar before cron has ever run', async () => {
    const eventStore = new D1EventStore(env.DB);
    const app = createApp({ eventStore, now: () => new Date('2026-08-22T00:00:00.000Z') });

    const response = await app.request('/committees.ics');

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('BEGIN:VEVENT');
  });

  it('a cron write is immediately visible on the next route request', async () => {
    const eventStore = new D1EventStore(env.DB);
    const now = new Date('2026-08-22T00:00:00.000Z');
    const events: NormalizedEvent[] = [
      {
        sourceId: 'test-source',
        externalId: '42',
        title: 'Test Committee Meeting',
        committeeName: 'Test Committee',
        startUtc: '2026-09-01T00:00:00.000Z',
        endUtc: null,
        location: null,
        url: null,
      },
    ];

    await syncAllSources({
      eventStore,
      config: CONFIG,
      slackWebhookUrl: 'https://hooks.example',
      now,
      fetchSourceEvents: async () => events,
    });

    const app = createApp({ eventStore, now: () => now });
    const response = await app.request('/committees.ics');
    const body = await response.text();
    expect(body).toContain('SUMMARY:Test Committee Meeting');
  });

  it('a meeting that disappears from the source (cancelled) is gone from the feed the next cron run', async () => {
    const eventStore = new D1EventStore(env.DB);
    const day1 = new Date('2026-08-23T00:00:00.000Z');
    const day2 = new Date('2026-08-24T00:00:00.000Z');
    const event: NormalizedEvent = {
      sourceId: 'test-source',
      externalId: 'cancel-me',
      title: 'Meeting That Gets Cancelled',
      committeeName: 'Test Committee',
      startUtc: '2026-09-15T00:00:00.000Z',
      endUtc: null,
      location: null,
      url: null,
    };

    await syncAllSources({
      eventStore,
      config: CONFIG,
      slackWebhookUrl: 'https://hooks.example',
      now: day1,
      fetchSourceEvents: async () => [event],
    });
    let app = createApp({ eventStore, now: () => day1 });
    expect(await (await app.request('/committees.ics')).text()).toContain('Meeting That Gets Cancelled');

    // Day 2's poll no longer returns it.
    await syncAllSources({
      eventStore,
      config: CONFIG,
      slackWebhookUrl: 'https://hooks.example',
      now: day2,
      fetchSourceEvents: async () => [],
    });
    app = createApp({ eventStore, now: () => day2 });
    expect(await (await app.request('/committees.ics')).text()).not.toContain('Meeting That Gets Cancelled');
  });

  it('a failing source does not prevent other sources\' events from being served', async () => {
    const eventStore = new D1EventStore(env.DB);
    const now = new Date('2026-08-22T00:00:00.000Z');
    const workingSource: LegistarSourceConfig = { ...SOURCE, id: 'working-source' };
    const brokenSource: LegistarSourceConfig = { ...SOURCE, id: 'broken-source' };
    const workingEvent: NormalizedEvent = {
      sourceId: 'working-source',
      externalId: '1',
      title: 'Still Works',
      committeeName: 'Test Committee',
      startUtc: '2026-09-01T00:00:00.000Z',
      endUtc: null,
      location: null,
      url: null,
    };

    await syncAllSources({
      eventStore,
      config: { sources: [workingSource, brokenSource] },
      slackWebhookUrl: 'https://hooks.example',
      now,
      fetchSourceEvents: async (source) => {
        if (source.id === 'broken-source') {
          throw new Error('simulated outage');
        }
        return [workingEvent];
      },
    });

    const app = createApp({ eventStore, now: () => now });
    const body = await (await app.request('/committees.ics')).text();
    expect(body).toContain('SUMMARY:Still Works');
  });
});
