import { describe, it, expect, vi } from 'vitest';
import { submitContactChanges } from './submitContactChanges';
import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { DonorContactInfo } from '../types';

const contact: DonorContactInfo = {
  id: 'donor-1',
  name: 'Jane Example',
  email: 'jane@example.org',
  address: '1 Old St',
  phone: '555-0100',
  preferredLanguage: 'English',
  employer: 'Acme',
  emailOptOut: false,
  smsOptOut: false,
  doNotMail: false,
};

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

function makeDeps(store = fakeStore(), employerEnabled = false) {
  return {
    store,
    monday: { getDonorContactInfo: vi.fn().mockResolvedValue(contact) } as unknown as MondayClient,
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    dedupeWindowHours: 72,
    now: () => new Date('2026-11-19T10:00:00.000Z'),
    employerEnabled,
  };
}

const unchanged = { address: '1 Old St', email: 'jane@example.org', phone: '555-0100', language: 'English' };
const shown = { emailWas: 'jane@example.org' };
const fields = (store: ChangeRequestStore) =>
  (store.createRequest as ReturnType<typeof vi.fn>).mock.calls.map(([row]) => [row.field, row.newValue]);

describe('submitContactChanges', () => {
  it('files one request per changed field, in form order, ignoring surrounding whitespace', async () => {
    const store = fakeStore();
    const result = await submitContactChanges(
      ['donor-1'],
      { donorItemId: 'donor-1', values: { ...unchanged, phone: ' 555-0199 ', address: '2 New Ave', language: ' English ' }, ...shown },
      makeDeps(store)
    );
    expect(result).toEqual({ kind: 'submitted', submitted: 2, duplicates: 0 });
    expect(fields(store)).toEqual([
      ['address', '2 New Ave'],
      ['phone', '555-0199'],
    ]);
  });

  it('reports noChanges when every field matches, and treats a blank field as no change', async () => {
    const store = fakeStore();
    expect(await submitContactChanges(['donor-1'], { donorItemId: 'donor-1', values: unchanged, ...shown }, makeDeps(store))).toEqual({ kind: 'noChanges' });
    expect(await submitContactChanges(['donor-1'], { donorItemId: 'donor-1', values: { ...unchanged, email: '', phone: '  ' }, ...shown }, makeDeps(store))).toEqual({
      kind: 'noChanges',
    });
    expect(store.createRequest).not.toHaveBeenCalled();
  });

  it('files Employer only while the employer answer is on', async () => {
    const off = fakeStore();
    expect(await submitContactChanges(['donor-1'], { donorItemId: 'donor-1', values: { ...unchanged, employer: 'Google' }, ...shown }, makeDeps(off))).toEqual({ kind: 'noChanges' });
    const on = fakeStore();
    await submitContactChanges(['donor-1'], { donorItemId: 'donor-1', values: { ...unchanged, employer: 'Google' }, ...shown }, makeDeps(on, true));
    expect(fields(on)).toEqual([['employer', 'Google']]);
  });

  it("refuses a donor outside the session and an over-long value, before reading Monday", async () => {
    const deps = makeDeps();
    expect((await submitContactChanges(['donor-1'], { donorItemId: 'other', values: unchanged }, deps)).kind).toBe('invalid');
    expect((await submitContactChanges(['donor-1'], { donorItemId: 'donor-1', values: { address: 'x'.repeat(501) } }, deps)).kind).toBe('invalid');
    expect(deps.monday.getDonorContactInfo).not.toHaveBeenCalled();
  });

  it('counts a repeat of a recent request as a duplicate', async () => {
    const store = fakeStore({ findRecentByDedupeHash: vi.fn().mockResolvedValue({ id: 7, status: 'written' }) as ChangeRequestStore['findRecentByDedupeHash'] });
    const result = await submitContactChanges(['donor-1'], { donorItemId: 'donor-1', values: { ...unchanged, address: '2 New Ave' }, ...shown }, makeDeps(store));
    expect(result).toEqual({ kind: 'submitted', submitted: 0, duplicates: 1 });
  });

  it("never diffs email against Monday: a correct guess at an address the form didn't show still files, so it reveals nothing", async () => {
    const store = fakeStore();
    // The form showed no email (emailWas ''); the guess matches Monday's exactly.
    const result = await submitContactChanges(['donor-1'], { donorItemId: 'donor-1', values: { ...unchanged }, emailWas: '' }, makeDeps(store));
    expect(result).toEqual({ kind: 'submitted', submitted: 1, duplicates: 0 });
    expect(fields(store)).toEqual([['email', 'jane@example.org']]);
  });
});
