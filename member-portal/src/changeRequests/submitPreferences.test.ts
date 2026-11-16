import { describe, it, expect, vi } from 'vitest';
import { submitPreferences } from './submitPreferences';
import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { DonorContactInfo } from '../types';

const contact: DonorContactInfo = {
  id: 'donor-1',
  name: 'Jane Example',
  email: 'jane@example.org',
  address: '1 Old St',
  phone: '555-0100',
  preferredLanguage: 'English', employer: '',
  emailOptOut: false,
  smsOptOut: false,
  doNotMail: true,
};

function fakeStore(overrides: Partial<ChangeRequestStore> = {}): ChangeRequestStore {
  return {
    createRequest: vi.fn().mockResolvedValue(42),
    hasRecentDuplicate: vi.fn().mockResolvedValue(false),
    findRecentByDedupeHash: vi.fn().mockResolvedValue(null),
    getRequest: vi.fn().mockResolvedValue(null),
    markWritten: vi.fn().mockResolvedValue(undefined),
    purgeWrittenBefore: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function makeDeps(store = fakeStore(), contactOverrides: Partial<DonorContactInfo> = {}) {
  return {
    store,
    monday: {
      getDonorContactInfo: vi.fn().mockResolvedValue({ ...contact, ...contactOverrides }),
    } as unknown as MondayClient,
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    dedupeWindowHours: 72,
    now: () => new Date('2026-08-25T10:00:00.000Z'),
  };
}

describe('submitPreferences', () => {
  it('submits one change request per changed preference, in field order', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);

    const result = await submitPreferences(
      ['donor-1'],
      { donorItemId: 'donor-1', prefs: { emailOptOut: true, smsOptOut: false, doNotMail: false } },
      deps
    );

    expect(result).toEqual({ kind: 'submitted', submitted: 2, duplicates: 0 });
    expect(store.createRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.createRequest).mock.calls[0]![0]).toMatchObject({
      field: 'emailOptOut',
      oldValue: 'Subscribed to email',
      newValue: 'Opted out of email',
    });
    expect(vi.mocked(store.createRequest).mock.calls[1]![0]).toMatchObject({
      field: 'doNotMail',
      oldValue: 'Do not mail',
      newValue: 'OK to mail',
    });
  });

  it('reports noChanges when every submitted preference already matches Monday', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);

    const result = await submitPreferences(
      ['donor-1'],
      { donorItemId: 'donor-1', prefs: { emailOptOut: false, smsOptOut: false, doNotMail: true } },
      deps
    );

    expect(result).toEqual({ kind: 'noChanges' });
    expect(store.createRequest).not.toHaveBeenCalled();
  });

  it('counts an already-pending duplicate separately from fresh submissions', async () => {
    const store = fakeStore({
      findRecentByDedupeHash: vi
        .fn()
        .mockResolvedValueOnce({ id: 7, status: 'written' })
        .mockResolvedValue(null),
    });
    const deps = makeDeps(store);

    const result = await submitPreferences(
      ['donor-1'],
      { donorItemId: 'donor-1', prefs: { emailOptOut: true, doNotMail: false } },
      deps
    );

    expect(result).toEqual({ kind: 'submitted', submitted: 1, duplicates: 1 });
    expect(store.createRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a donor item id outside the session', async () => {
    const result = await submitPreferences(
      ['donor-1'],
      { donorItemId: 'donor-2', prefs: { emailOptOut: true } },
      makeDeps()
    );
    expect(result.kind).toBe('invalid');
  });

  it('rejects a preference whose Donors-board column is unconfigured', async () => {
    const result = await submitPreferences(
      ['donor-1'],
      { donorItemId: 'donor-1', prefs: { smsOptOut: true } },
      makeDeps(fakeStore(), { smsOptOut: null })
    );
    expect(result.kind).toBe('invalid');
  });

  it('reports noChanges for an empty preference set rather than erroring', async () => {
    const result = await submitPreferences(['donor-1'], { donorItemId: 'donor-1', prefs: {} }, makeDeps());
    expect(result).toEqual({ kind: 'noChanges' });
  });
});
