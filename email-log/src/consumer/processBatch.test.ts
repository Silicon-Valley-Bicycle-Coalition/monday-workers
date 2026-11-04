import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processLogBatch } from './processBatch';
import { retryDelaySeconds } from '../flags';
import { PLACEHOLDER_COLUMN_ID } from '../config';
import type { LogQueueMessage } from '../inbound/extract';
import { MondayApiError } from '../monday/graphql';
import { FakeStore, fakeMessage, fakeMonday, fakeReply } from '../test/fakes';
import { testConfig, type DeepPartial } from '../test/testConfig';
import type { EmailLogConfig } from '../types';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const HASH = 'ab'.repeat(32);
const OTHER_HASH = 'cd'.repeat(32);
const BOARD = 111;
const IT = { boardId: 900, typeColumn: 'it_type', typeLabel: 'Integration', cooldownDays: 7 };

function logMessage(overrides: Partial<LogQueueMessage> = {}): LogQueueMessage {
  return {
    messageIdHash: HASH,
    kind: 'bcc',
    staffEmail: 'dana@example.org',
    counterparts: ['pat@gmail.com', 'lee@corp.com'],
    subject: 'Ride planning',
    dateISO: '2026-10-19T17:05:09.000Z',
    body: 'Hello',
    attachmentNames: [],
    ...overrides,
  };
}

const PAT = { '42:personal_email_col:pat@gmail.com': ['11'] };
const LEE = { '42:household_email_col:lee@corp.com': ['22'] };

async function setup(lookups: Record<string, string[]> = {}, configOverrides: DeepPartial<EmailLogConfig> = {}, count?: number) {
  // Rows arrive claimed ('queued') by the email handler, as in production.
  const store = new FakeStore();
  await store.claim(HASH);
  await store.claim(OTHER_HASH);
  const monday = fakeMonday(lookups, { count });
  const reply = fakeReply();
  const config = testConfig(configOverrides);
  return { store, monday, reply, deps: { config, store, monday, reply, now: () => NOW } };
}

// Creates on the Activities board only (alert creates go to the IT board).
const activityCreates = (monday: ReturnType<typeof fakeMonday>) => monday.createItem.mock.calls.filter(([board]) => board === BOARD);

let error: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('retry backoff', () => {
  it('a failed attempt backs off on the shared curve: 1 min doubling to an hour', async () => {
    for (const [attempts, delay] of [[1, 60], [2, 120], [7, 3600], [8, 3600]] as const) {
      const { monday, reply, deps } = await setup(PAT);
      monday.createItem.mockRejectedValueOnce(new Error('boom'));
      const msg = fakeMessage(logMessage(), attempts);
      await processLogBatch([msg], deps);
      expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: delay });
      expect(reply.sendUnmatched).not.toHaveBeenCalled();
    }
  });
});

describe('processLogBatch', () => {
  it('full match: creates the item, marks logged, sends no reply, acks', async () => {
    const { store, monday, reply, deps } = await setup({ ...PAT, ...LEE });
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(activityCreates(monday)).toHaveLength(1);
    const [, name, columnValues] = activityCreates(monday)[0]!;
    expect(name).toBe('Ride planning');
    expect(columnValues).toMatchObject({ person_col: { item_ids: [11, 22] }, status_col: { label: 'Done' }, hash_col: HASH });
    expect(store.logged.get(HASH)).toBe('1000');
    expect(reply.sendUnmatched).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('partial match: creates, replies with the unmatched list and the item URL', async () => {
    const { store, reply, deps } = await setup(PAT);
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(store.logged.get(HASH)).toBe('1000');
    expect(reply.sendUnmatched).toHaveBeenCalledWith(
      'dana@example.org',
      'Ride planning',
      `https://example.monday.com/boards/${BOARD}/pulses/1000`,
      ['lee@corp.com'],
      false
    );
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('no match: creates with Needs Person, replies with nothingMatched', async () => {
    const { monday, reply, deps } = await setup();
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    const [, , columnValues] = activityCreates(monday)[0]!;
    expect(columnValues).toMatchObject({ status_col: { label: 'Needs Person' } });
    expect(columnValues).not.toHaveProperty('person_col');
    expect(reply.sendUnmatched).toHaveBeenCalledWith(
      'dana@example.org',
      'Ride planning',
      `https://example.monday.com/boards/${BOARD}/pulses/1000`,
      ['pat@gmail.com', 'lee@corp.com'],
      true
    );
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('zero counterparts: creates Needs Person and sends the no-address reply', async () => {
    const { store, monday, reply, deps } = await setup();
    const msg = fakeMessage(logMessage({ counterparts: [] }));
    await processLogBatch([msg], deps);

    const [, , columnValues] = activityCreates(monday)[0]!;
    expect(columnValues).toMatchObject({ status_col: { label: 'Needs Person' } });
    expect(store.logged.get(HASH)).toBe('1000');
    expect(reply.sendNoAddress).toHaveBeenCalledWith('dana@example.org', 'Ride planning', `https://example.monday.com/boards/${BOARD}/pulses/1000`);
    expect(reply.sendUnmatched).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('adopts an existing item by Message Hash before creating', async () => {
    const { store, monday, reply, deps } = await setup({ [`${BOARD}:hash_col:${HASH}`]: ['555'] });
    const msg = fakeMessage(logMessage(), 2);
    await processLogBatch([msg], deps);

    expect(monday.findItemIdsByColumnValue).toHaveBeenCalledWith(BOARD, 'hash_col', HASH);
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(store.logged.get(HASH)).toBe('555');
    expect(reply.sendUnmatched).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('reply failure does not fail the message', async () => {
    const { store, reply, deps } = await setup();
    reply.sendUnmatched.mockRejectedValueOnce(new Error('send failed'));
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(store.logged.get(HASH)).toBe('1000');
    expect(store.failed.size).toBe(0);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain(HASH.slice(0, 12));
    expect(String(error.mock.calls[0]![0])).not.toContain(HASH.slice(0, 13));
  });

  it('Monday 429 → retry with retryDelaySeconds(attempts)', async () => {
    const { store, monday, deps } = await setup();
    monday.createItem.mockRejectedValueOnce(new MondayApiError('rate limited', { httpStatus: 429 }));
    const msg = fakeMessage(logMessage(), 2);
    await processLogBatch([msg], deps);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(2) });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(store.errors.get(HASH)).toBe('rate limited');
    expect(store.failed.size).toBe(0);
    expect(store.logged.size).toBe(0);
  });

  it('a retry keeps the row queued so a redelivery is still a duplicate', async () => {
    const { store, monday, deps } = await setup();
    monday.createItem.mockRejectedValueOnce(new MondayApiError('rate limited', { httpStatus: 429 }));
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(msg.retry).toHaveBeenCalled();
    expect(store.status.get(HASH)).toBe('queued');
    expect(await store.claim(HASH)).toBe(false);
  });

  it('still retries when recording the failure fails too', async () => {
    const { store, monday, deps } = await setup();
    store.failBookkeeping = true;
    monday.createItem.mockRejectedValueOnce(new MondayApiError('rate limited', { httpStatus: 429 }));
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it('"Board has reached its max size" → raises the board-full alert and retries', async () => {
    const { store, monday, deps } = await setup({}, { alerts: { itRequests: IT } });
    monday.createItem.mockImplementation(async (board: number) => {
      if (board === BOARD) throw new MondayApiError('Board has reached its max size', { code: 'ItemsLimitationException' });
      return '9001';
    });
    const msg = fakeMessage(logMessage(), 3);
    await processLogBatch([msg], deps);

    expect(monday.createItem).toHaveBeenCalledWith(900, `email-log: Activities (Logged) board ${BOARD} is full`, { it_type: { label: 'Integration' } });
    expect(store.alerts.get('board-full')?.itemId).toBe('9001');
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(3) });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('at warnPct of activitiesMaxItems → raises the capacity alert and still writes', async () => {
    const { store, monday, deps } = await setup({}, { alerts: { itRequests: IT }, capacity: { activitiesMaxItems: 1000, warnPct: 90 } }, 900);
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(monday.createItem).toHaveBeenCalledWith(900, `email-log: Activities (Logged) board ${BOARD} holds 900 of 1000 items`, {
      it_type: { label: 'Integration' },
    });
    expect(store.alerts.has('capacity')).toBe(true);
    expect(activityCreates(monday)).toHaveLength(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('below warnPct raises no alert', async () => {
    const { store, deps } = await setup({}, { alerts: { itRequests: IT }, capacity: { activitiesMaxItems: 1000, warnPct: 90 } }, 899);
    await processLogBatch([fakeMessage(logMessage())], deps);
    expect(store.alerts.size).toBe(0);
  });

  it('refuses to write while activities-logged is null', async () => {
    const { store, monday, deps } = await setup({}, { monday: { boards: { 'activities-logged': null } } });
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(monday.createItem).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(store.errors.get(HASH)).toBe('config: monday.boards.activities-logged is not configured');
  });

  it('refuses to write while an activities column is the placeholder', async () => {
    const { store, monday, deps } = await setup({}, { activities: { notesColumn: PLACEHOLDER_COLUMN_ID } });
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(monday.createItem).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalled();
    expect(store.errors.get(HASH)).toBe('config: activities.notesColumn is not configured');
  });

  it('processes each message independently', async () => {
    const { monday, deps } = await setup({ ...PAT, ...LEE });
    monday.createItem.mockRejectedValueOnce(new Error('boom'));
    const first = fakeMessage(logMessage({ messageIdHash: OTHER_HASH }));
    const second = fakeMessage(logMessage());
    await processLogBatch([first, second], deps);
    expect(first.retry).toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalled();
  });

  it('posts a Logged email timeline entry on each matched person, after the item is logged', async () => {
    const { store, monday, reply, deps } = await setup({ ...PAT, ...LEE }, { timeline: { customActivityId: 'act-1' } });
    const msg = fakeMessage(logMessage());
    await processLogBatch([msg], deps);

    expect(monday.createTimelineItem).toHaveBeenCalledTimes(2);
    expect(monday.createTimelineItem.mock.calls.map(([input]) => input.itemId)).toEqual(['11', '22']);
    expect(monday.createTimelineItem.mock.calls[0]![0]).toMatchObject({
      customActivityId: 'act-1',
      title: 'Ride planning',
      timestamp: '2026-10-19T17:05:09.000Z',
      url: `https://example.monday.com/boards/${BOARD}/pulses/1000`,
    });
    expect(store.logged.get(HASH)).toBe('1000');
    expect(reply.sendUnmatched).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('posts no timeline entry while timeline.customActivityId is null', async () => {
    const { monday, deps } = await setup({ ...PAT, ...LEE });
    await processLogBatch([fakeMessage(logMessage())], deps);
    expect(monday.createTimelineItem).not.toHaveBeenCalled();
  });

  it('posts no timeline entry when nobody matched', async () => {
    const { monday, deps } = await setup({}, { timeline: { customActivityId: 'act-1' } });
    await processLogBatch([fakeMessage(logMessage())], deps);
    expect(monday.createTimelineItem).not.toHaveBeenCalled();
  });

  it('posts no timeline entry when adopting an existing item', async () => {
    const { monday, deps } = await setup({ ...PAT, [`${BOARD}:hash_col:${HASH}`]: ['555'] }, { timeline: { customActivityId: 'act-1' } });
    await processLogBatch([fakeMessage(logMessage(), 2)], deps);
    expect(monday.createTimelineItem).not.toHaveBeenCalled();
  });

  it('a timeline failure does not fail the message, skips no other person, and still replies', async () => {
    const { store, monday, reply, deps } = await setup({ ...PAT, ...LEE }, { timeline: { customActivityId: 'act-1' } });
    monday.createTimelineItem.mockRejectedValueOnce(new Error('timeline down'));
    const msg = fakeMessage(logMessage({ counterparts: ['pat@gmail.com', 'lee@corp.com', 'kim@x.org'] }));
    await processLogBatch([msg], deps);

    expect(monday.createTimelineItem).toHaveBeenCalledTimes(2);
    expect(store.logged.get(HASH)).toBe('1000');
    expect(reply.sendUnmatched).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    const lines = error.mock.calls.map((args: unknown[]) => args.map(String).join(' ')).join('\n');
    expect(lines).toContain('timeline');
    expect(lines).not.toMatch(/@|Ride planning/);
  });

  it('never logs an address or subject', async () => {
    const { monday, reply, deps } = await setup();
    monday.createItem.mockRejectedValueOnce(new Error('boom'));
    reply.sendUnmatched.mockRejectedValueOnce(new Error('send failed'));
    await processLogBatch([fakeMessage(logMessage()), fakeMessage(logMessage())], deps);
    const lines = [...error.mock.calls, ...log.mock.calls].map((args) => args.map(String).join(' ')).join('\n');
    expect(lines).not.toMatch(/@|Ride planning/);
  });
});
