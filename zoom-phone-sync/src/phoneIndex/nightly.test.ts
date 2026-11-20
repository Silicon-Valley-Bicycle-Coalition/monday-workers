import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { PhoneQueueMessage } from '../db/events';
import { D1PhoneIndexStore } from '../db/phoneIndex';
import type { WriteMode } from '../flags';
import type { PeoplePhone } from '../monday/client';
import { testConfig } from '../test/testConfig';
import { runNightly } from './nightly';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

let people: PeoplePhone[];
let sent: PhoneQueueMessage[];
let mode: WriteMode;
let sendFails: boolean;

const store = () => new D1PhoneIndexStore(env.DB);
const run = () =>
  runNightly({
    monday: { listPeoplePhones: async () => people },
    store: store(),
    queue: {
      sendBatch: async (messages) => {
        if (sendFails) throw new Error('queue unavailable');
        sent.push(...messages);
      },
    },
    config: testConfig(),
    writeMode: async () => mode,
    now: () => NOW,
  });

const index = () =>
  env.DB.prepare('SELECT e164, item_id FROM phone_index ORDER BY e164, item_id').all<{ e164: string; item_id: string }>().then((r) => r.results);
const events = () =>
  env.DB.prepare('SELECT event_id, status, enqueued_at FROM phone_events ORDER BY event_id').all<Record<string, unknown>>().then((r) => r.results);

async function insertEvent(id: string, status: string, occurredAt: string, e164: string | null) {
  await env.DB.prepare(
    `INSERT INTO phone_events (event_id, kind, occurred_at, zoom_user_id, external_e164, direction, status, received_at)
     VALUES (?, 'call', ?, 'u1', ?, 'inbound', ?, ?)`,
  ).bind(id, occurredAt, e164, status, occurredAt).run();
}

beforeEach(async () => {
  people = [];
  sent = [];
  mode = 'on';
  sendFails = false;
  await env.DB.exec('DELETE FROM phone_events; DELETE FROM phone_index;');
});

describe('runNightly: index rebuild', () => {
  it('normalizes every People phone and replaces the index', async () => {
    await env.DB.prepare(`INSERT INTO phone_index VALUES ('+14085550199', 'stale')`).run();
    people = [
      { itemId: '1', phone: '(408) 555-0101' },
      { itemId: '2', phone: '408.555.0102 x7' },
      { itemId: '3', phone: null },
      { itemId: '4', phone: 'ask front desk' },
    ];
    const summary = await run();
    expect(await index()).toEqual([
      { e164: '+14085550101', item_id: '1' },
      { e164: '+14085550102', item_id: '2' },
    ]);
    expect(summary).toMatchObject({ items: 4, withPhone: 3, unusable: 1, indexed: 2, numbers: 2 });
  });

  it('indexes a shared household number on each person', async () => {
    people = [
      { itemId: '1', phone: '(408) 555-0101' },
      { itemId: '2', phone: '+1 408 555 0101' },
    ];
    const summary = await run();
    expect(await index()).toHaveLength(2);
    expect(summary).toMatchObject({ indexed: 2, numbers: 1 });
  });

  it('pages past D1 bound-parameter limits in one transaction', async () => {
    people = Array.from({ length: 1234 }, (_, i) => ({ itemId: String(i), phone: `408555${String(1000 + i).padStart(4, '0')}` }));
    await run();
    expect(await index()).toHaveLength(1234);
  });

  it('keeps the old index when People reads back with no usable phone', async () => {
    await env.DB.prepare(`INSERT INTO phone_index VALUES ('+14085550101', '1')`).run();
    people = [{ itemId: '1', phone: null }];
    await expect(run()).rejects.toThrow(/no usable phone/);
    expect(await index()).toHaveLength(1);
  });

  it('runs on an empty board', async () => {
    await expect(run()).resolves.toMatchObject({ items: 0, indexed: 0 });
  });
});

describe('runNightly: unmatched rows', () => {
  beforeEach(() => {
    people = [{ itemId: '1', phone: '(408) 555-0101' }];
  });

  it('rematches recent unmatched events whose number is now indexed and enqueues them', async () => {
    await insertEvent('match', 'unmatched', daysAgo(2), '+14085550101');
    await insertEvent('nomatch', 'unmatched', daysAgo(2), '+14085550999');
    await insertEvent('logged', 'logged', daysAgo(2), '+14085550101');
    const summary = await run();
    expect(sent).toEqual([{ eventId: 'match' }]);
    expect(summary.rematched).toBe(1);
    expect(await events()).toEqual([
      { event_id: 'logged', status: 'logged', enqueued_at: null },
      { event_id: 'match', status: 'pending', enqueued_at: new Date(NOW).toISOString() },
      { event_id: 'nomatch', status: 'unmatched', enqueued_at: null },
    ]);
  });

  it('stamps rematched messages like ingest does under off', async () => {
    mode = 'off';
    await insertEvent('match', 'unmatched', daysAgo(1), '+14085550101');
    await run();
    expect(sent).toEqual([{ eventId: 'match', writeStamp: 'dropped' }]);
  });

  it('deletes unmatched events past retention, number and all, before rematching', async () => {
    await insertEvent('old', 'unmatched', daysAgo(15), '+14085550101');
    await insertEvent('oldLogged', 'logged', daysAgo(30), null);
    const summary = await run();
    expect(summary.expired).toBe(1);
    expect(sent).toEqual([]);
    expect((await events()).map((e) => e.event_id)).toEqual(['oldLogged']);
  });

  it('leaves rows unmatched when the queue send fails', async () => {
    sendFails = true;
    await insertEvent('match', 'unmatched', daysAgo(1), '+14085550101');
    await expect(run()).rejects.toThrow(/queue unavailable/);
    expect((await events())[0]).toMatchObject({ status: 'unmatched' });
  });

  it('sends more than 100 rematches in batches of 100', async () => {
    for (let i = 0; i < 150; i++) await insertEvent(`e${String(i).padStart(3, '0')}`, 'unmatched', daysAgo(1), '+14085550101');
    const summary = await run();
    expect(sent).toHaveLength(150);
    expect(summary.rematched).toBe(150);
    expect((await events()).every((e) => e.status === 'pending')).toBe(true);
  });
});
