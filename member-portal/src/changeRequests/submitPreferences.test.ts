import { describe, it, expect, vi } from 'vitest';
import { submitPreferences } from './submitPreferences';
import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { DonorContactInfo } from '../types';
import { sha256Hex } from '../crypto/hash';

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

  // The store answers by value: which requests are still in the dedupe window, with their ids.
  async function pendingStore(pending: Record<string, number>) {
    const byHash = new Map<string, { id: number; status: 'written' }>();
    for (const [key, id] of Object.entries(pending)) byHash.set(await sha256Hex(key), { id, status: 'written' });
    return fakeStore({ findRecentByDedupeHash: vi.fn(async (hash: string) => byHash.get(hash) ?? null) });
  }
  const created = (store: ChangeRequestStore) => (store.createRequest as ReturnType<typeof vi.fn>).mock.calls.map(([row]) => [row.field, row.oldValue, row.newValue]);

  it('treats a choice that repeats the pending request as no change', async () => {
    const store = await pendingStore({ 'donor-1|emailOptOut|Opted out of email': 7 });
    const result = await submitPreferences(['donor-1'], { donorItemId: 'donor-1', prefs: { emailOptOut: true, doNotMail: false } }, makeDeps(store));
    expect(result).toEqual({ kind: 'submitted', submitted: 1, duplicates: 0 });
    expect(created(store)).toEqual([['doNotMail', 'Do not mail', 'OK to mail']]);
  });

  it('files a switch-back over a pending request, though it matches Monday, recording what it overrides', async () => {
    // Monday still says subscribed; the opt-out saved a moment ago is pending.
    const store = await pendingStore({ 'donor-1|emailOptOut|Opted out of email': 7 });
    const deps = makeDeps(store);
    const result = await submitPreferences(['donor-1'], { donorItemId: 'donor-1', prefs: { emailOptOut: false } }, deps);
    expect(result).toEqual({ kind: 'submitted', submitted: 1, duplicates: 0 });
    expect(created(store)).toEqual([['emailOptOut', 'Opted out of email', 'Subscribed to email']]);
    expect(deps.queue.send).toHaveBeenCalledOnce();
  });

  it('files a third switch though an identical first request is still in the window', async () => {
    const store = await pendingStore({ 'donor-1|emailOptOut|Opted out of email': 7, 'donor-1|emailOptOut|Subscribed to email': 9 });
    const result = await submitPreferences(['donor-1'], { donorItemId: 'donor-1', prefs: { emailOptOut: true } }, makeDeps(store));
    expect(result).toEqual({ kind: 'submitted', submitted: 1, duplicates: 0 });
    expect(created(store)).toEqual([['emailOptOut', 'Subscribed to email', 'Opted out of email']]);
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
