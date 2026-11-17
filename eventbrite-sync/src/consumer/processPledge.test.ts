import { describe, it, expect, vi, type Mock } from 'vitest';
import { PLACEHOLDER_COLUMN_ID } from '../config';
import { processAttendee } from './processAttendee';
import { consumeWriteBatch } from './processBatch';
import { fakeAttendeeStore, fakeEventStore } from '../test/fakeStores';
import { testConfig, withPledge } from '../test/testConfig';
import { mondayItem } from '../test/mondayItem';
import { MondayApiError } from '../monday/graphql';
import { EMPLOYER_ANSWER, EMPLOYER_ANSWERS, PERSON_ITEM_ID, expectNotWritten, expectRecordedBetween, fakeEmployerSink, peopleLookup, withSink } from '../test/employerAnswers';
import type { ProcessBatchDeps } from './processBatch';
import type { EventbriteAttendee } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import type { AttendeeRow } from '../types';

const config = withPledge(testConfig());
const placeholder = { name: 'Info Requested Info Requested', email: 'Info Requested' };

function attendee(overrides: Partial<EventbriteAttendee> = {}): EventbriteAttendee {
  return {
    id: 'a1', event_id: '9100', created: '2026-05-01T20:00:00Z', order_id: '700',
    profile: { name: 'Pat Rider', email: 'pat@example.com' },
    answers: [{ question_id: '11', question: 'Zip', type: 'text', answer: '95014' }],
    ...overrides,
  };
}

function row(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    attendeeId: 'a1', eventId: '9100', mondayItemId: null, matchedPersonItemId: null, status: 'received', lastAction: 'attendee.updated',
    error: null, deliveries: 1, receivedAt: '2026-05-01T20:00:00.000Z', writtenAt: null, ...overrides,
  };
}

function setup(opts: { att?: EventbriteAttendee | null; row?: AttendeeRow; order?: unknown; monday?: Partial<MondayClient>; cfg?: typeof config } = {}) {
  const mondayClient: MondayClient = {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'p-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn().mockResolvedValue([]),
    postUpdate: vi.fn(),
    createTimelineItem: vi.fn(),
    ...opts.monday,
  };
  const eventStore = fakeEventStore({ getEvent: vi.fn().mockResolvedValue(null), recordDelivery: vi.fn() });
  const attendeeStore = fakeAttendeeStore({ getAttendee: vi.fn().mockResolvedValue(opts.row ?? row()) });
  const queue = { send: vi.fn(), sendBatch: vi.fn() };
  const eventbriteClient = {
    getOrder: vi.fn().mockResolvedValue(opts.order === undefined ? { id: '700', name: 'Sam Buyer', email: 'sam@example.com' } : opts.order),
    getEvent: vi.fn(),
    getAttendee: vi.fn().mockResolvedValue(opts.att === undefined ? attendee() : opts.att),
  };
  const deps = { eventStore, attendeeStore, queue, mondayClient, eventbriteClient, config: opts.cfg ?? config } as unknown as ProcessBatchDeps;
  return { deps, eventStore, attendeeStore, queue, mondayClient, eventbriteClient };
}

const message = { kind: 'attendee' as const, eventId: '9100', attendeeId: 'a1', action: 'attendee.updated' };
const createCall = (m: MondayClient) => (m.createItem as ReturnType<typeof vi.fn>).mock.calls[0]!;

describe('processAttendee for a pledge event', () => {
  it('creates on the pledge board, not Event Registrations, with no event wait', async () => {
    const { deps, mondayClient, eventStore, eventbriteClient, attendeeStore, queue } = setup();
    await processAttendee(message, deps);
    const [board, name, values, options] = createCall(mondayClient);
    expect(board).toBe(444);
    expect(name).toBe('Pat Rider');
    expect(values.p_id).toBe('a1');
    expect(options).toEqual({ createLabelsIfMissing: true });
    expect(eventbriteClient.getEvent).not.toHaveBeenCalled();
    expect(eventStore.recordDelivery).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'p-1', writtenAt: expect.any(String) }));
  });

  it('leaves another event on Event Registrations', async () => {
    const { deps, eventStore, eventbriteClient } = setup({ att: attendee({ event_id: '9001' }), row: row({ eventId: '9001' }) });
    (eventStore.getEvent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(processAttendee({ ...message, eventId: '9001' }, deps)).rejects.toThrow(/no Events item yet/);
    expect(eventbriteClient.getAttendee).not.toHaveBeenCalled();
  });

  it('leaves everything on Event Registrations with no pledge config', async () => {
    const { deps } = setup({ cfg: testConfig() });
    await expect(processAttendee(message, deps)).rejects.toThrow(/no Events item yet/);
  });

  it('adopts by attendee id', async () => {
    const { deps, mondayClient, attendeeStore } = setup({ monday: {
      findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'p-7' }),
      getItems: vi.fn().mockResolvedValue([mondayItem('p-7', 'Pat', {})]),
    } });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(444, 'p_id', 'a1');
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(444, 'p-7', expect.objectContaining({ p_id: 'a1', name: 'Pat Rider' }), { createLabelsIfMissing: true });
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'p-7' }));
  });

  it('skips the lookup when the ledger has the item, so a redelivery writes no second item', async () => {
    const { deps, mondayClient } = setup({ row: row({ mondayItemId: 'p-7' }), monday: { getItems: vi.fn().mockResolvedValue([mondayItem('p-7', 'Pat', {})]) } });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('fetches the order of a placeholder, and writes its buyer', async () => {
    const { deps, mondayClient, eventbriteClient } = setup({ att: attendee({ profile: placeholder, answers: [] }) });
    await processAttendee(message, deps);
    expect(eventbriteClient.getOrder).toHaveBeenCalledTimes(1);
    expect(eventbriteClient.getOrder).toHaveBeenCalledWith('700');
    const [, name, values] = createCall(mondayClient);
    expect(name).toBe('Sam Buyer');
    expect(values.p_email).toEqual({ email: 'sam@example.com', text: 'sam@example.com' });
    expect(values.p_details).toEqual({ label: 'Buyer only' });
  });

  it('does not fetch the order of a complete pledge', async () => {
    const { deps, eventbriteClient } = setup();
    await processAttendee(message, deps);
    expect(eventbriteClient.getOrder).not.toHaveBeenCalled();
  });

  it('still writes a placeholder whose order is gone', async () => {
    const { deps, mondayClient, attendeeStore } = setup({ att: attendee({ profile: placeholder, answers: [] }), order: null });
    await processAttendee(message, deps);
    const [, name, values] = createCall(mondayClient);
    expect(name).toBe('Pledge a1');
    expect(values).not.toHaveProperty('p_email');
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.anything());
  });

  it('still writes a placeholder with no order id', async () => {
    const { deps, mondayClient, eventbriteClient } = setup({ att: attendee({ profile: placeholder, answers: [], order_id: null }) });
    await processAttendee(message, deps);
    expect(eventbriteClient.getOrder).not.toHaveBeenCalled();
    expect(createCall(mondayClient)[1]).toBe('Pledge a1');
  });

  it('marks a 404 attendee failed without writing', async () => {
    const { deps, mondayClient, attendeeStore } = setup({ att: null });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: 'attendee not found in Eventbrite (HTTP 404)' });
  });

  it('does not recreate a deleted item', async () => {
    const { deps, mondayClient, attendeeStore } = setup({ row: row({ mondayItemId: 'p-7' }), monday: { getItems: vi.fn().mockResolvedValue([]) } });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: expect.stringContaining('deleted or archived') });
  });

  it('refuses to write while the idempotency column is a placeholder', async () => {
    const cfg = withPledge(testConfig());
    cfg.pledge!.columns.attendeeIdColumn = PLACEHOLDER_COLUMN_ID;
    const { deps, mondayClient } = setup({ cfg });
    await expect(processAttendee(message, deps)).rejects.toThrow(/attendeeIdColumn/);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('throws when the pledge board is not configured', async () => {
    const cfg = withPledge(testConfig());
    cfg.monday.boards['pledge-to-ride'] = null;
    const { deps } = setup({ cfg });
    await expect(processAttendee(message, deps)).rejects.toThrow(/pledge-to-ride/);
  });
});

describe('a pledge write Monday refuses', () => {
  const refusal = () => new MondayApiError('Bad value "SecretAnswer" for column', { code: 'ColumnValueException' });

  it('keeps the rejected value out of the log and the ledger, and stays terminal', async () => {
    const { deps, attendeeStore } = setup({ monday: { createItem: vi.fn().mockRejectedValue(refusal()) } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = { body: message, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await consumeWriteBatch([m], { ...deps, orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } } as ProcessBatchDeps, {
      worker: 'eventbrite-sync', environment: 'production', mode: 'on', logLevel: 'normal', piiKeys: [],
    });
    const logged = error.mock.calls.flat().map(String).join('\n');
    error.mockRestore();
    const recorded = JSON.stringify((attendeeStore.updateStatus as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('SecretAnswer');
    expect(recorded).not.toContain('SecretAnswer');
    expect(recorded).toContain('ColumnValueException');
    expect(m.ack).toHaveBeenCalled();
  });

  it('scrubs a refused update too, but still recognizes a gone item', async () => {
    const existing = { row: row({ mondayItemId: 'p-7' }) };
    const getItems = vi.fn().mockResolvedValue([mondayItem('p-7', 'Pat', {})]);
    const refused = setup({ ...existing, monday: { getItems, changeColumnValues: vi.fn().mockRejectedValue(refusal()) } });
    const err = await processAttendee(message, refused.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MondayApiError);
    expect((err as Error).message).not.toContain('SecretAnswer');

    const gone = setup({ ...existing, monday: { getItems, changeColumnValues: vi.fn().mockRejectedValue(new MondayApiError('Item not found', { code: 'ItemNotFound' })) } });
    await processAttendee(message, gone.deps);
    expect(gone.attendeeStore.updateStatus).toHaveBeenCalledWith('a1', 'failed', { error: expect.stringContaining('deleted or archived') });
  });
});

describe('pledges under the write switch', () => {
  const full = (deps: ProcessBatchDeps): ProcessBatchDeps => ({ ...deps, orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } });
  const gate = { worker: 'eventbrite-sync', environment: 'production', mode: 'off' as const, piiKeys: ['name', 'email'] };
  const msg = () => ({ body: message, attempts: 1, ack: vi.fn(), retry: vi.fn() });

  it('off writes nothing, changes no ledger row, and logs the skip under the board name', async () => {
    const { deps, mondayClient, attendeeStore } = setup();
    const m = msg();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([m], full(deps), { ...gate, logLevel: 'normal' });
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      expect(attendeeStore.updateStatus).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalled();
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('"sink":"Pledge to Ride"');
    } finally {
      log.mockRestore();
    }
  });

  it('off at debug log level keeps answers out of the log', async () => {
    const { deps } = setup({ att: attendee({ answers: [
      { question_id: '11', question: 'Zip', type: 'text', answer: '95014' },
      { question_id: '15', question: 'Who asked', type: 'text', answer: 'SecretNeighbor' },
      { question_id: '18', question: 'I see myself as', type: 'text', answer: 'SecretSelfDescription' },
    ] }) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeWriteBatch([msg()], full(deps), { ...gate, logLevel: 'debug' });
      const text = log.mock.calls.flat().map(String).join('\n');
      expect(text).toContain('"sink":"Pledge to Ride"');
      expect(text).not.toContain('SecretNeighbor');
      expect(text).not.toContain('SecretSelfDescription');
      expect(text).not.toContain('95014');
    } finally {
      log.mockRestore();
    }
  });
});

describe('pledge employer answers', () => {
  const pledgeAttendee = () => attendee({ answers: [{ question_id: '11', question: 'Zip', type: 'text', answer: '95014' }, ...EMPLOYER_ANSWERS] });

  it('on create, records the answer after the board write and before the ledger says written', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ att: pledgeAttendee(), monday: { findItemByColumnValue: peopleLookup() } });
    await processAttendee(message, withSink(s.deps, sink));
    expect(sink.recordEmployerAnswer).toHaveBeenCalledWith({
      source: 'eventbrite', sourceId: 'a1', personItemId: PERSON_ITEM_ID, answer: EMPLOYER_ANSWER, answeredAt: '2026-05-01', context: 'Pledge to Ride 2026',
    });
    expectRecordedBetween(s.mondayClient.createItem as Mock, sink, s.attendeeStore);
  });

  it('on update, records the answer after the board write and before the ledger says written', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ att: pledgeAttendee(), row: row({ mondayItemId: 'p-7' }), monday: { findItemByColumnValue: peopleLookup(), getItems: vi.fn().mockResolvedValue([mondayItem('p-7', 'Pat', {})]) } });
    await processAttendee(message, withSink(s.deps, sink));
    expectRecordedBetween(s.mondayClient.changeColumnValues as Mock, sink, s.attendeeStore);
  });

  it('a thrown hand-over leaves the row unwritten and propagates; the retry adopts the item it created', async () => {
    const sink = fakeEmployerSink();
    sink.recordEmployerAnswer.mockRejectedValueOnce(new Error('impact-attribution unreachable'));
    let created: string | null = null;
    const s = setup({
      att: pledgeAttendee(),
      monday: {
        findItemByColumnValue: peopleLookup((board) => (board === 444 && created !== null ? { id: created } : null)),
        createItem: vi.fn().mockImplementation(async () => { created = 'p-1'; return { id: 'p-1' }; }),
        getItems: vi.fn().mockResolvedValue([mondayItem('p-1', 'Pat', {})]),
      },
    });
    const deps = withSink(s.deps, sink);
    await expect(processAttendee(message, deps)).rejects.toThrow('impact-attribution unreachable');
    expectNotWritten(s.attendeeStore);
    await processAttendee(message, deps);
    expect(s.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(s.mondayClient.changeColumnValues).toHaveBeenCalledWith(444, 'p-1', expect.anything(), expect.anything());
    expect(sink.recordEmployerAnswer).toHaveBeenCalledTimes(2);
    expect(s.attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'p-1' }));
  });

  it('a gone item records nothing', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ att: pledgeAttendee(), row: row({ mondayItemId: 'p-7' }), monday: { findItemByColumnValue: peopleLookup(), getItems: vi.fn().mockResolvedValue([]) } });
    await processAttendee(message, withSink(s.deps, sink));
    expect(sink.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it('under off, sends nothing and logs ids only', async () => {
    const sink = fakeEmployerSink();
    const s = setup({ att: pledgeAttendee(), monday: { findItemByColumnValue: peopleLookup() } });
    const full = { ...withSink(s.deps, sink), orderStore: { recordDelivery: vi.fn(), updateStatus: vi.fn(), getOrder: vi.fn() } } as ProcessBatchDeps;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const m = { body: message, attempts: 1, ack: vi.fn(), retry: vi.fn() };
      await consumeWriteBatch([m], full, { worker: 'eventbrite-sync', environment: 'production', mode: 'off', logLevel: 'debug', piiKeys: ['name', 'email'] });
      expect(m.ack).toHaveBeenCalled();
      expect(sink.recordEmployerAnswer).not.toHaveBeenCalled();
      const text = log.mock.calls.flat().map(String).join('\n');
      expect(text).toContain('"sink":"Employer answers"');
      expect(text).not.toContain(EMPLOYER_ANSWER);
      expect(text).not.toContain('Pledge to Ride 2026');
    } finally {
      log.mockRestore();
    }
  });
});
