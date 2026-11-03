import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeLogBatch } from './consumer/processBatch';
import { DEFAULT_PII_KEYS, type WriteMode } from './flags';
import type { LogQueueMessage } from './inbound/extract';
import { DROPPED_ERROR, EMAIL_LOG_PII_KEYS, type BatchSkipContext } from './writeSwitch';
import { FakeStore, fakeMessage, fakeMonday, fakeReply } from './test/fakes';
import { testConfig } from './test/testConfig';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const HASH = 'ab'.repeat(32);
const PAT = { '42:personal_email_col:pat@gmail.com': ['11'] };
const IT = { boardId: 900, typeColumn: 'it_type', typeLabel: 'Integration', cooldownDays: 7 };

function logMessage(overrides: Partial<LogQueueMessage> = {}): LogQueueMessage {
  return {
    messageIdHash: HASH,
    kind: 'bcc',
    staffEmail: 'dana@example.org',
    counterparts: ['pat@gmail.com', 'stranger@corp.com'],
    subject: 'Ride planning secret',
    dateISO: '2026-10-19T17:05:09.000Z',
    body: 'Hello this is the private body',
    attachmentNames: [],
    ...overrides,
  };
}

function gate(mode: WriteMode, logLevel: 'normal' | 'debug' = 'normal'): BatchSkipContext {
  return { worker: 'email-log', environment: 'production', mode, logLevel, piiKeys: EMAIL_LOG_PII_KEYS };
}

async function setup(itAlerts = false) {
  const store = new FakeStore();
  await store.claim(HASH);
  const monday = fakeMonday(PAT);
  const reply = fakeReply();
  const config = testConfig(itAlerts ? { alerts: { itRequests: IT } } : {});
  return { store, monday, reply, deps: { config, store, monday, reply, now: () => NOW } };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const skips = () => logs.filter((l) => l.includes('"writeSwitch":"skipped"')).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('email-log write switch: consumer', () => {
  it('subject joins the default PII keys', () => {
    expect(EMAIL_LOG_PII_KEYS).toEqual([...DEFAULT_PII_KEYS, 'subject']);
  });

  it('under on, an unstamped (legacy) message writes the item and the reply', async () => {
    const { store, monday, reply, deps } = await setup();
    const msg = fakeMessage(logMessage());
    await consumeLogBatch([msg], deps, gate('on'));
    expect(monday.createItem).toHaveBeenCalledTimes(1);
    expect(reply.sendUnmatched).toHaveBeenCalledTimes(1);
    expect(store.logged.get(HASH)).toBe('1000');
    expect(msg.ack).toHaveBeenCalled();
    expect(skips()).toEqual([]);
  });

  it('under off, writes nothing: no createItem, no reply, no markLogged; one skip line each; acks', async () => {
    const { store, monday, reply, deps } = await setup();
    const msg = fakeMessage(logMessage());
    await consumeLogBatch([msg], deps, gate('off'));
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(reply.sendUnmatched).not.toHaveBeenCalled();
    expect(reply.sendNoAddress).not.toHaveBeenCalled();
    expect(reply.sendNotLogged).not.toHaveBeenCalled();
    expect(store.logged.size).toBe(0);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(skips().map((s) => `${s.sink}.${s.operation}`)).toEqual(['Monday.createItem', 'Email.sendUnmatched']);
    expect(skips()[0]).toMatchObject({ mode: 'off', worker: 'email-log', deliveryId: HASH.slice(0, 12), args: 3 });
  });

  it('under off, the no-address reply and the IT Requests alert are recorded too, with no D1 alert row', async () => {
    const { store, monday, reply, deps } = await setup(true);
    const msg = fakeMessage(logMessage({ counterparts: [] }));
    monday.boardItemsCount.mockResolvedValue(100_000);
    await consumeLogBatch([msg], deps, gate('off'));
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(reply.sendNoAddress).not.toHaveBeenCalled();
    expect(store.alerts.size).toBe(0);
    expect(skips().map((s) => `${s.sink}.${s.operation}`)).toEqual(['Monday.createItem', 'Monday.createItem', 'Email.sendNoAddress']);
  });

  it('under off, closes the row out as failed (dropped) so a staff re-send is not swallowed as a duplicate', async () => {
    const { store, deps } = await setup();
    await consumeLogBatch([fakeMessage(logMessage())], deps, gate('off'));
    expect(store.status.get(HASH)).toBe('failed');
    expect(store.failed.get(HASH)).toBe(DROPPED_ERROR);
    expect(await store.claim(HASH)).toBe(true);
  });

  it('a message stamped dropped stays a dry run even once the mode is on', async () => {
    const { monday, reply, deps } = await setup();
    const msg = fakeMessage(logMessage({ writeStamp: 'dropped' }));
    await consumeLogBatch([msg], deps, gate('on'));
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(reply.sendUnmatched).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('if the dropped close-out write fails, backs the message off and rehearses nothing', async () => {
    const { store, monday, deps } = await setup();
    store.failBookkeeping = true;
    const msg = fakeMessage(logMessage(), 3);
    await consumeLogBatch([msg], deps, gate('off'));
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(monday.findItemIdsByColumnValue).not.toHaveBeenCalled();
    expect(skips()).toEqual([]);
  });

  it.each(['hold', 'unknown'] as const)('under %s, retries at 60 s without touching anything', async (mode) => {
    const { store, monday, reply, deps } = await setup();
    const msg = fakeMessage(logMessage());
    await consumeLogBatch([msg], deps, gate(mode));
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(monday.findItemIdsByColumnValue).not.toHaveBeenCalled();
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(reply.sendUnmatched).not.toHaveBeenCalled();
    expect(store.status.get(HASH)).toBe('queued');
  });

  it('under hold, attempt 8 backs off 3600 s', async () => {
    const { deps } = await setup();
    const msg = fakeMessage(logMessage(), 8);
    await consumeLogBatch([msg], deps, gate('hold'));
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
  });

  it('debug logs subject and body as lengths only, and never an address', async () => {
    const { deps } = await setup();
    const m = logMessage();
    await consumeLogBatch([fakeMessage(m)], deps, gate('off', 'debug'));
    const all = logs.join('\n');
    expect(all).not.toContain('secret');
    expect(all).not.toContain('private body');
    expect(all).not.toMatch(/@/);
    expect(all).toContain(`<masked:${m.subject.length}>`);
    expect(all).toContain(`<text:${m.body.length}>`);
    expect(logs.some((l) => l.includes('"writeSwitch":"debug"'))).toBe(true);
  });

  it('normal level logs no payload at all', async () => {
    const { deps } = await setup();
    await consumeLogBatch([fakeMessage(logMessage())], deps, gate('off'));
    for (const s of skips()) expect(s).not.toHaveProperty('payload');
    expect(logs.some((l) => l.includes('"writeSwitch":"debug"'))).toBe(false);
  });
});
