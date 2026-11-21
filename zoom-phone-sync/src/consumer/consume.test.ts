import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { D1LogStore, type PhoneQueueMessage } from '../db/events';
import type { WriteMode } from '../flags';
import { MondayApiError } from '../monday/graphql';
import type { PhoneLogMondayClient, TimelineEntry } from '../monday/client';
import { testConfig } from '../test/testConfig';
import type { ZoomPhoneSyncConfig } from '../types';
import { consumeBatch, processDeadLetters, type QueueMessageLike } from './consume';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const NUMBER = '+14085550123';

function config(): ZoomPhoneSyncConfig {
  const c = testConfig();
  return {
    ...c,
    people: { ...c.people, lastPhoneContactColumn: 'date_lpc' },
    timeline: { callActivityId: 'act_call', textActivityId: 'act_text' },
    zoom: { ...c.zoom, smsUrl: 'https://zoom.example/sms' },
  };
}

interface FakeMonday extends PhoneLogMondayClient {
  created: TimelineEntry[];
  dates: { itemId: string; date: string }[];
  names: Map<string, string>;
  failCreate: Error | null;
  failCreateOnItem: string | null;
}

function fakeMonday(): FakeMonday {
  const fake: FakeMonday = {
    created: [],
    dates: [],
    names: new Map([['101', 'Jane Rider'], ['102', 'Sam Rider']]),
    failCreate: null,
    failCreateOnItem: null,
    async itemNames(ids) {
      return new Map(ids.filter((id) => fake.names.has(id)).map((id) => [id, fake.names.get(id)!]));
    },
    async advanceDate(_board, itemId, _column, date) {
      fake.dates.push({ itemId, date });
      return 'set';
    },
    async createTimelineItem(entry) {
      if (fake.failCreate !== null && (fake.failCreateOnItem === null || fake.failCreateOnItem === entry.itemId)) throw fake.failCreate;
      fake.created.push(entry);
      return `tl_${fake.created.length}`;
    },
  };
  return fake;
}

interface FakeMessage extends QueueMessageLike<PhoneQueueMessage> {
  outcome: 'ack' | { retry: number | undefined } | null;
}

function message(eventId: string, extra: Partial<PhoneQueueMessage> = {}, attempts = 1): FakeMessage {
  const m: FakeMessage = {
    body: { eventId, ...extra },
    attempts,
    outcome: null,
    ack() {
      m.outcome = 'ack';
    },
    retry(options) {
      m.outcome = { retry: options?.delaySeconds };
    },
  };
  return m;
}

async function insertEvent(id: string, over: Record<string, unknown> = {}) {
  const row = {
    kind: 'call', occurred_at: '2026-11-19T18:00:00Z', staff_name: 'Ann Staff', external_e164: NUMBER,
    direction: 'outbound', result: 'answered', talk_seconds: 725, status: 'pending', ...over,
  };
  await env.DB.prepare(
    `INSERT INTO phone_events (event_id, kind, occurred_at, zoom_user_id, staff_name, external_e164, direction, result, talk_seconds, status, received_at)
     VALUES (?, ?, ?, 'u1', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, row.kind, row.occurred_at, row.staff_name, row.external_e164, row.direction, row.result, row.talk_seconds, row.status, row.occurred_at).run();
}

const index = (e164: string, itemId: string) => env.DB.prepare('INSERT INTO phone_index VALUES (?, ?)').bind(e164, itemId).run();
const row = (id: string) => env.DB.prepare('SELECT status, external_e164, logged_at, attempts FROM phone_events WHERE event_id = ?').bind(id).first<Record<string, unknown>>();
const items = (id: string) => env.DB.prepare('SELECT item_id, timeline_id FROM phone_event_items WHERE event_id = ? ORDER BY item_id').bind(id).all().then((r) => r.results);

let monday: FakeMonday;
let mode: WriteMode;
const run = (messages: FakeMessage[]) => consumeBatch(messages, mode, { store: new D1LogStore(env.DB), monday, config: config(), now: () => NOW });

beforeEach(async () => {
  monday = fakeMonday();
  mode = 'on';
  await env.DB.exec('DELETE FROM phone_events; DELETE FROM phone_event_items; DELETE FROM phone_index;');
});

describe('consumeBatch: writes', () => {
  it('logs an answered call on the matching person, advances Last Phone Contact and clears the number', async () => {
    await insertEvent('e1');
    await index(NUMBER, '101');
    const m = message('e1');
    const counts = await run([m]);
    expect(m.outcome).toBe('ack');
    expect(counts.logged).toBe(1);
    expect(monday.dates).toEqual([{ itemId: '101', date: '2026-11-19' }]);
    expect(monday.created).toEqual([
      expect.objectContaining({ itemId: '101', customActivityId: 'act_call', title: 'Call with Jane Rider', summary: 'Outbound · 12 min', timestamp: '2026-11-19T18:00:00Z' }),
    ]);
    expect(await row('e1')).toMatchObject({ status: 'logged', external_e164: null, logged_at: new Date(NOW).toISOString() });
    expect(await items('e1')).toEqual([{ item_id: '101', timeline_id: 'tl_1' }]);
  });

  it('logs a shared number on each person', async () => {
    await insertEvent('e1');
    await index(NUMBER, '101');
    await index(NUMBER, '102');
    await run([message('e1')]);
    expect(monday.created.map((e) => e.itemId)).toEqual(['101', '102']);
  });

  it('logs a missed call without moving Last Phone Contact', async () => {
    await insertEvent('e1', { direction: 'inbound', result: 'voicemail', talk_seconds: 0 });
    await index(NUMBER, '101');
    await run([message('e1')]);
    expect(monday.dates).toEqual([]);
    expect(monday.created[0]).toMatchObject({ title: 'Missed call from Jane Rider' });
  });

  it('logs a text with the text activity and the Zoom link', async () => {
    await insertEvent('t1', { kind: 'text', direction: 'inbound', result: null, talk_seconds: null });
    await index(NUMBER, '101');
    await run([message('t1')]);
    expect(monday.dates).toHaveLength(1);
    expect(monday.created[0]).toMatchObject({ customActivityId: 'act_text', title: 'Text from Jane Rider' });
    expect(monday.created[0]!.content).toContain('https://zoom.example/sms');
  });

  it('marks an event with no matching person unmatched and keeps its number for the rematch', async () => {
    await insertEvent('e1');
    const m = message('e1');
    const counts = await run([m]);
    expect(m.outcome).toBe('ack');
    expect(counts.unmatched).toBe(1);
    expect(monday.created).toEqual([]);
    expect(await row('e1')).toMatchObject({ status: 'unmatched', external_e164: NUMBER });
  });

  it('treats an unmatched row it is handed (a rematch) like a pending one', async () => {
    await insertEvent('e1', { status: 'unmatched' });
    await index(NUMBER, '101');
    await run([message('e1')]);
    expect(await row('e1')).toMatchObject({ status: 'logged' });
  });

  it('skips a person deleted since the index was built, and waits when none is left', async () => {
    await insertEvent('e1');
    await index(NUMBER, '999');
    await run([message('e1')]);
    expect(monday.created).toEqual([]);
    expect(await row('e1')).toMatchObject({ status: 'unmatched' });
  });

  it('acks a redelivery of a logged event without writing again', async () => {
    await insertEvent('e1', { status: 'logged', external_e164: null });
    const m = message('e1');
    const counts = await run([m]);
    expect(m.outcome).toBe('ack');
    expect(counts.skipped).toBe(1);
    expect(monday.created).toEqual([]);
  });

  it('acks a message whose row is gone', async () => {
    const m = message('ghost');
    expect((await run([m])).missing).toBe(1);
    expect(m.outcome).toBe('ack');
  });
});

describe('consumeBatch: partial failure and retries', () => {
  it('a retry after a partial failure writes only the people still missing an entry', async () => {
    await insertEvent('e1');
    await index(NUMBER, '101');
    await index(NUMBER, '102');
    monday.failCreate = new Error('item 102 rejected');
    monday.failCreateOnItem = '102';
    const first = message('e1');
    await run([first]);
    expect(first.outcome).toEqual({ retry: 60 });
    expect(await row('e1')).toMatchObject({ status: 'pending', attempts: 1, external_e164: NUMBER });

    monday.failCreate = null;
    await run([message('e1', {}, 2)]);
    expect(monday.created.map((e) => e.itemId)).toEqual(['101', '102']);
    expect(await items('e1')).toHaveLength(2);
    expect(await row('e1')).toMatchObject({ status: 'logged' });
  });

  it('defers the rest of the batch without calling Monday after an outage', async () => {
    await insertEvent('e1');
    await insertEvent('e2');
    await index(NUMBER, '101');
    monday.failCreate = new MondayApiError('rate limited', { httpStatus: 429, retryAfterSeconds: 120 });
    const [a, b] = [message('e1'), message('e2')];
    await run([a, b]);
    expect(a.outcome).toEqual({ retry: 120 });
    expect(b.outcome).toEqual({ retry: 120 });
    expect(await row('e2')).toMatchObject({ attempts: 0 });
  });

  it('retries when a needed config id is missing', async () => {
    await insertEvent('e1');
    await index(NUMBER, '101');
    const m = message('e1');
    await consumeBatch([m], 'on', {
      store: new D1LogStore(env.DB),
      monday,
      config: { ...config(), timeline: { callActivityId: null, textActivityId: 'act_text' } },
    });
    expect(m.outcome).toEqual({ retry: 60 });
    expect(monday.created).toEqual([]);
  });
});

describe('consumeBatch: write switch', () => {
  it('under hold leaves the message queued without touching D1 or Monday', async () => {
    mode = 'hold';
    await insertEvent('e1');
    const m = message('e1', {}, 3);
    await run([m]);
    expect(m.outcome).toEqual({ retry: 240 });
    expect(await row('e1')).toMatchObject({ status: 'pending' });
  });

  it('under off marks the row dropped and clears the number without calling Monday', async () => {
    mode = 'off';
    await insertEvent('e1');
    await index(NUMBER, '101');
    const m = message('e1');
    await run([m]);
    expect(m.outcome).toBe('ack');
    expect(monday.created).toEqual([]);
    expect(await row('e1')).toMatchObject({ status: 'dropped', external_e164: null });
  });

  it('a message stamped dropped stays a dry run after a flip to on', async () => {
    await insertEvent('e1');
    await index(NUMBER, '101');
    await run([message('e1', { writeStamp: 'dropped' })]);
    expect(monday.created).toEqual([]);
    expect(await row('e1')).toMatchObject({ status: 'dropped' });
  });
});

describe('processDeadLetters', () => {
  it('marks pending rows failed and leaves logged ones alone', async () => {
    await insertEvent('e1');
    await insertEvent('e2', { status: 'logged', external_e164: null });
    const [a, b] = [message('e1'), message('e2')];
    await processDeadLetters([a, b], new D1LogStore(env.DB));
    expect(a.outcome).toBe('ack');
    expect(b.outcome).toBe('ack');
    expect(await row('e1')).toMatchObject({ status: 'failed' });
    expect(await row('e2')).toMatchObject({ status: 'logged' });
  });
});
