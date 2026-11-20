import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordEmployerAnswer, type EmployerAnswerSink } from './employerAnswer';
import { consumeFunraiseBatch, processFunraiseQueueBatch, type FunraiseQueueMessage, type QueueMessageLike } from './processBatch';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EventRow } from '../types';
import { testConfig } from '../test/testConfig';

// GitHub #6: the matching-gift company on a one-time gift goes to impact-attribution.

const COMPANY = 'Acme Secret Widgets';
const EMAIL = 'ada@example.org';
const on = { ...testConfig({ entityIdColumn: 'entity_col' }), employerAnswers: { enabled: true } };
const off = testConfig({ entityIdColumn: 'entity_col' });
const NOW = new Date('2026-11-19T12:00:00Z');

const gift = (over: Record<string, unknown> = {}) => ({
  amount: 100,
  donationDate: Date.UTC(2026, 10, 18, 17),
  donor: { contactId: 'fr-1', email: EMAIL, name: 'Ada' },
  companyMatch: { companyName: COMPANY, companyId: 7, employeeEmail: EMAIL },
  ...over,
});

const sink = (impl?: EmployerAnswerSink['recordEmployerAnswer']) =>
  ({ recordEmployerAnswer: impl ? vi.fn(impl) : vi.fn().mockResolvedValue({ recorded: true }) });

// Everything console.* was handed, so a test can assert the company and email never appear.
function captureLogs(): () => string {
  const spies = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return () => spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('recordEmployerAnswer', () => {
  it('hands over the company on a one-time gift, keyed to the transaction and the People item', async () => {
    const s = sink();
    await recordEmployerAnswer(gift(), 'txn-1', '55', '2026-11-18', { config: on, employerAnswers: s }, NOW);
    expect(s.recordEmployerAnswer).toHaveBeenCalledWith({
      source: 'funraise', sourceId: 'txn-1', personItemId: '55', answer: COMPANY, answeredAt: '2026-11-18', context: 'Funraise transaction txn-1',
    });
  });

  it('dates the answer today when the gift has no parseable date', async () => {
    const s = sink();
    await recordEmployerAnswer(gift(), 'txn-1', '55', null, { config: on, employerAnswers: s }, NOW);
    expect(s.recordEmployerAnswer.mock.calls[0]![0].answeredAt).toBe('2026-11-19');
  });

  it('trims the company and cuts it to 200 characters', async () => {
    const s = sink();
    await recordEmployerAnswer(gift({ companyMatch: { companyName: `  ${'x'.repeat(250)}` } }), 'txn-1', '55', '2026-11-18', { config: on, employerAnswers: s }, NOW);
    expect(s.recordEmployerAnswer.mock.calls[0]![0].answer).toBe('x'.repeat(200));
  });

  it.each([
    ['the switch is off', off, gift()],
    ['an installment', on, gift({ subscription: { id: 26 } })],
    ['no companyMatch', on, gift({ companyMatch: null })],
    ['a blank company', on, gift({ companyMatch: { companyName: '  ' } })],
    ['a non-string company', on, gift({ companyMatch: { companyName: 7 } })],
  ])('does nothing for %s', async (_n, config, payload) => {
    const s = sink();
    await recordEmployerAnswer(payload, 'txn-1', '55', '2026-11-18', { config, employerAnswers: s }, NOW);
    expect(s.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it('does nothing without the binding, even when switched on', async () => {
    await expect(recordEmployerAnswer(gift(), 'txn-1', '55', '2026-11-18', { config: on, employerAnswers: null }, NOW)).resolves.toBeUndefined();
  });

  it('logs a refusal with ids and the reason only', async () => {
    const logs = captureLogs();
    await recordEmployerAnswer(gift(), 'txn-1', '55', '2026-11-18', { config: on, employerAnswers: sink(async () => ({ recorded: false, reason: 'non-answer' })) }, NOW);
    expect(logs()).toContain('transaction "txn-1" employer answer not recorded: non-answer');
    expect(logs()).not.toContain(COMPANY);
  });

  it('swallows a thrown RPC and logs only the error class, never what was handed over', async () => {
    const logs = captureLogs();
    const s = sink(async () => { throw new TypeError(`D1 down while storing ${COMPANY} for ${EMAIL}`); });
    await expect(recordEmployerAnswer(gift(), 'txn-1', '55', '2026-11-18', { config: on, employerAnswers: s }, NOW)).resolves.toBeUndefined();
    expect(logs()).toContain('RPC failed (TypeError)');
    expect(logs()).not.toContain(COMPANY);
    expect(logs()).not.toContain(EMAIL);
  });
});

describe('the consumer', () => {
  function eventRow(payload: object, over: Partial<EventRow> = {}): EventRow {
    return {
      eventId: 'evt-1', entityType: 'transaction', entityId: 'txn-1', rawPayload: JSON.stringify(payload),
      matchedDonorItemId: null, mondayItemId: null, status: 'queued', error: null, receivedAt: '2026-11-18T00:00:00.000Z', writtenAt: null, ...over,
    };
  }
  function fakeStore(row: EventRow): EventStore {
    return {
      upsertEvent: vi.fn(), updateStatusByEntity: vi.fn().mockResolvedValue(undefined), getEventByEntity: vi.fn().mockResolvedValue(row),
      purgeWrittenPayloads: vi.fn(), purgeUnresolvedPayloads: vi.fn().mockResolvedValue(0),
    };
  }
  // The donor lookup on People (42) hits item 55; the orphan lookup on Donations misses.
  const monday = (): MondayClient => ({
    findItemByColumnValue: vi.fn().mockImplementation(async (boardId: number) => (boardId === 42 ? { id: '55' } : null)),
    createItem: vi.fn().mockResolvedValue({ id: 'item-1' }),
    changeColumnValues: vi.fn(),
  });
  const message = (): QueueMessageLike<FunraiseQueueMessage> & { ack: any; retry: any } =>
    ({ body: { entityType: 'transaction', entityId: 'txn-1' }, ack: vi.fn(), retry: vi.fn() });

  it('hands over the company with the matched donor and the gift date, then writes the donation', async () => {
    const s = sink();
    const mondayClient = monday();
    const m = message();
    await processFunraiseQueueBatch([m], { eventStore: fakeStore(eventRow(gift())), mondayClient, config: on, employerAnswers: s });
    expect(s.recordEmployerAnswer).toHaveBeenCalledWith(expect.objectContaining({ source: 'funraise', sourceId: 'txn-1', personItemId: '55', answeredAt: '2026-11-18' }));
    expect(mondayClient.createItem).toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('still writes and acks the donation when the RPC throws', async () => {
    captureLogs();
    const mondayClient = monday();
    const m = message();
    const s = sink(async () => { throw new Error('impact-attribution unavailable'); });
    await processFunraiseQueueBatch([m], { eventStore: fakeStore(eventRow(gift())), mondayClient, config: on, employerAnswers: s });
    expect(mondayClient.createItem).toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('under off, logs a skip line with ids only and never calls the RPC', async () => {
    const logs = captureLogs();
    const s = sink();
    const gate = { worker: 'funraise-sync', environment: 'production' as const, mode: 'off' as const, logLevel: 'debug' as const, piiKeys: ['name', 'email'] };
    await consumeFunraiseBatch([message()], { eventStore: fakeStore(eventRow(gift(), { matchedDonorItemId: '55' })), mondayClient: monday(), config: on, employerAnswers: s }, gate);
    expect(s.recordEmployerAnswer).not.toHaveBeenCalled();
    const skip = logs().split('\n').find((l) => l.includes('"sink":"Employer answers"'));
    expect(skip).toBeDefined();
    expect(JSON.parse(skip!)).toMatchObject({ operation: 'recordEmployerAnswer', payload: [{ source: 'funraise', sourceId: 'txn-1', personItemId: '55' }] });
    expect(logs()).not.toContain(COMPANY);
  });
});
