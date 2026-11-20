import { describe, it, expect, vi } from 'vitest';
import { submitChangeRequest, FIELD_LABELS, MAX_NEW_VALUE_LENGTH } from './submitChangeRequest';
import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';

function fakeStore(overrides: Partial<ChangeRequestStore> = {}): ChangeRequestStore {
  return {
    createRequest: vi.fn().mockResolvedValue(42),
    hasRecentDuplicate: vi.fn().mockResolvedValue(false),
    findRecentByDedupeHash: vi.fn().mockResolvedValue(null),
    getRequest: vi.fn().mockResolvedValue(null),
    markWritten: vi.fn().mockResolvedValue(undefined),
    hasNewerRequest: vi.fn().mockResolvedValue(false),
    purgeWrittenBefore: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function fakeMonday(): MondayClient {
  return {
    getDonorContactInfo: vi.fn().mockResolvedValue({
      id: 'donor-1',
      name: 'Jane Example',
      email: 'jane@example.org',
      address: '1 Old St',
      phone: '555-0100',
      preferredLanguage: 'English',
      employer: 'Acme',
      emailOptOut: false,
      smsOptOut: false,
      doNotMail: true,
    }),
  } as unknown as MondayClient;
}

function makeDeps(store = fakeStore()) {
  return {
    store,
    monday: fakeMonday(),
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    dedupeWindowHours: 72,
    now: () => new Date('2026-08-24T10:00:00.000Z'),
  };
}

describe('FIELD_LABELS', () => {
  it('has a staff-facing label for the language field', () => {
    expect(FIELD_LABELS.language).toBe('Preferred Language');
  });

  it('has a staff-facing label for each communication preference field', () => {
    expect(FIELD_LABELS.emailOptOut).toBe('Email Opt-Out');
    expect(FIELD_LABELS.smsOptOut).toBe('SMS Opt-Out');
    expect(FIELD_LABELS.doNotMail).toBe('Do Not Mail');
  });
});

describe('submitChangeRequest', () => {
  it('records the request with the current Monday value as old_value and enqueues it', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: ' 2 New Ave ' }, deps);

    expect(result).toEqual({ kind: 'submitted' });
    expect(store.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        donorItemId: 'donor-1',
        donorName: 'Jane Example',
        field: 'address',
        oldValue: '1 Old St',
        newValue: '2 New Ave', // trimmed
        createdAt: '2026-08-24T10:00:00.000Z',
      })
    );
    expect(deps.queue.send).toHaveBeenCalledWith({ requestId: 42 });
  });

  it('records the current preferred language as old_value for a language change', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'language', newValue: 'Vietnamese' }, deps);

    expect(result).toEqual({ kind: 'submitted' });
    expect(store.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        field: 'language',
        oldValue: 'English',
        newValue: 'Vietnamese',
      })
    );
  });

  it('accepts a Monday label as the newValue for a language change (not a locale code)', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'language', newValue: 'Spanish' }, deps);

    expect(result).toEqual({ kind: 'submitted' });
    expect(store.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        donorItemId: 'donor-1',
        field: 'language',
        newValue: 'Spanish',
      })
    );
  });

  it('rejects a donor item id outside the session', async () => {
    const deps = makeDeps();
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'other', field: 'address', newValue: 'x' }, deps);
    expect(result.kind).toBe('invalid');
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('rejects an unknown field', async () => {
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'ssn', newValue: 'x' }, makeDeps());
    expect(result.kind).toBe('invalid');
  });

  it('rejects an empty and an oversized new value', async () => {
    const deps = makeDeps();
    expect((await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'phone', newValue: '   ' }, deps)).kind).toBe('invalid');
    const oversized = 'x'.repeat(MAX_NEW_VALUE_LENGTH + 1);
    expect((await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'phone', newValue: oversized }, deps)).kind).toBe('invalid');
  });

  it('reports a duplicate without inserting when the existing row was already written', async () => {
    const store = fakeStore({ findRecentByDedupeHash: vi.fn().mockResolvedValue({ id: 7, status: 'written' }) });
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }, deps);
    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createRequest).not.toHaveBeenCalled();
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  // Finding 1: createRequest runs before queue.send, so if the send throws the row is left
  // 'queued' with no matching message — every retry inside the dedupe window would otherwise
  // just tell the donor "already submitted" forever, and the request never reaches staff. On a
  // dedupe hit against a still-'queued' row, re-send its requestId so the consumer (which is
  // idempotent on written status) gets another chance to process it.
  it('re-sends the queue message for a stranded queued row on a duplicate submission', async () => {
    const store = fakeStore({ findRecentByDedupeHash: vi.fn().mockResolvedValue({ id: 7, status: 'queued' }) });
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }, deps);
    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createRequest).not.toHaveBeenCalled();
    expect(deps.queue.send).toHaveBeenCalledWith({ requestId: 7 });
  });

  it('computes the dedupe window from config hours', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }, deps);
    const sinceISO = (store.findRecentByDedupeHash as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(sinceISO).toBe('2026-08-21T10:00:00.000Z'); // now − 72h
  });

  it('rejects inherited property names like toString', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'toString', newValue: 'x' }, deps);
    expect(result.kind).toBe('invalid');
    expect(store.createRequest).not.toHaveBeenCalled();
    expect((deps.monday.getDonorContactInfo as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(deps.queue.send).not.toHaveBeenCalled();
  });
});

describe('submitChangeRequest — communication preference fields', () => {
  it('records a preference change with vocabulary old/new values', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);

    const result = await submitChangeRequest(
      ['donor-1'],
      { donorItemId: 'donor-1', field: 'emailOptOut', newValue: 'Opted out of email' },
      deps
    );

    expect(result).toEqual({ kind: 'submitted' });
    expect(store.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        field: 'emailOptOut',
        oldValue: 'Subscribed to email',
        newValue: 'Opted out of email',
      })
    );
  });

  it('maps a currently-checked checkbox to the opted-out old value', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);

    await submitChangeRequest(
      ['donor-1'],
      { donorItemId: 'donor-1', field: 'doNotMail', newValue: 'OK to mail' },
      deps
    );

    expect(store.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'doNotMail', oldValue: 'Do not mail', newValue: 'OK to mail' })
    );
  });

  it('rejects a preference value outside the fixed vocabulary', async () => {
    const deps = makeDeps();
    const result = await submitChangeRequest(
      ['donor-1'],
      { donorItemId: 'donor-1', field: 'smsOptOut', newValue: 'maybe' },
      deps
    );
    expect(result.kind).toBe('invalid');
  });

  it("rejects a free-text field's value being submitted under a preference field", async () => {
    const deps = makeDeps();
    const result = await submitChangeRequest(
      ['donor-1'],
      { donorItemId: 'donor-1', field: 'emailOptOut', newValue: '2 New Ave' },
      deps
    );
    expect(result.kind).toBe('invalid');
  });

  it('rejects a preference change while its Donors-board column is unconfigured', async () => {
    const deps = makeDeps();
    deps.monday = {
      getDonorContactInfo: vi.fn().mockResolvedValue({
        id: 'donor-1',
        name: 'Jane Example',
        email: 'jane@example.org',
        address: '1 Old St',
        phone: '555-0100',
        preferredLanguage: 'English',
        emailOptOut: null,
        smsOptOut: null,
        doNotMail: null,
      }),
    } as unknown as MondayClient;

    const result = await submitChangeRequest(
      ['donor-1'],
      { donorItemId: 'donor-1', field: 'emailOptOut', newValue: 'Opted out of email' },
      deps
    );

    expect(result.kind).toBe('invalid');
  });
});

describe('submitChangeRequest — employer', () => {
  it('records People → Employer Name as the old value and enqueues it', async () => {
    const store = fakeStore();
    const deps = { ...makeDeps(store), employerEnabled: true };
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'employer', newValue: ' Google ' }, deps);
    expect(result).toEqual({ kind: 'submitted' });
    expect(store.createRequest).toHaveBeenCalledWith(expect.objectContaining({ field: 'employer', oldValue: 'Acme', newValue: 'Google' }));
    expect(deps.queue.send).toHaveBeenCalledWith({ requestId: 42 });
  });

  it('is a duplicate within the dedupe window', async () => {
    const store = fakeStore({ findRecentByDedupeHash: vi.fn().mockResolvedValue({ id: 7, status: 'written' }) });
    const deps = { ...makeDeps(store), employerEnabled: true };
    expect(await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'employer', newValue: 'Google' }, deps)).toEqual({ kind: 'duplicate' });
    expect(store.createRequest).not.toHaveBeenCalled();
  });

  it('is an unknown field while the employer answer is off', async () => {
    const store = fakeStore();
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'employer', newValue: 'Google' }, makeDeps(store));
    expect(result).toEqual({ kind: 'invalid', message: 'Unknown field.' });
    expect(store.createRequest).not.toHaveBeenCalled();
  });

  it('labels the field Employer for staff', () => {
    expect(FIELD_LABELS.employer).toBe('Employer');
  });
});
