import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processDeadLetters } from './processDeadLetters';
import type { LogQueueMessage } from '../inbound/extract';
import { FakeStore, fakeMessage, fakeMonday, fakeReply } from '../test/fakes';
import { testConfig } from '../test/testConfig';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const HASH = 'ef'.repeat(32);
const IT = { boardId: 900, typeColumn: 'it_type', typeLabel: 'Integration', cooldownDays: 7 };

function logMessage(hash = HASH): LogQueueMessage {
  return {
    messageIdHash: hash,
    kind: 'forward',
    staffEmail: 'dana@example.org',
    counterparts: ['pat@gmail.com'],
    subject: 'Ride planning',
    dateISO: '2026-10-19T17:05:09.000Z',
    body: 'Hello',
    attachmentNames: [],
  };
}

function setup() {
  const store = new FakeStore();
  const monday = fakeMonday();
  const reply = fakeReply();
  return { store, monday, reply, deps: { config: testConfig({ alerts: { itRequests: IT } }), store, monday, reply, now: () => NOW } };
}

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('processDeadLetters', () => {
  it('marks failed, sends sendNotLogged to the staff member, raises the dead-letter alert, acks', async () => {
    const { store, monday, reply, deps } = setup();
    const msg = fakeMessage(logMessage());
    await processDeadLetters([msg], deps);

    expect(store.failed.get(HASH)).toBe('dead-lettered after retries');
    expect(reply.sendNotLogged).toHaveBeenCalledWith('dana@example.org', 'Ride planning');
    expect(monday.createItem).toHaveBeenCalledWith(900, `email-log: a message (${HASH.slice(0, 12)}) could not be logged after retries`, {
      it_type: { label: 'Integration' },
    });
    expect(store.alerts.has('dead-letter')).toBe(true);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('acks even when the ledger and the reply both fail', async () => {
    const { store, reply, deps } = setup();
    store.failMarkFailed = true;
    reply.sendNotLogged.mockRejectedValueOnce(new Error('send failed'));
    const msg = fakeMessage(logMessage());
    await processDeadLetters([msg], deps);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('logs one summary line per batch with the count, and no address or subject', async () => {
    const { deps } = setup();
    await processDeadLetters([fakeMessage(logMessage()), fakeMessage(logMessage('01'.repeat(32)))], deps);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line).toContain('2 messages');
    expect(line).not.toMatch(/@|Ride planning/);
  });
});
