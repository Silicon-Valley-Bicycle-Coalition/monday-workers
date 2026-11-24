import { describe, it, expect, vi } from 'vitest';
import { checkMember, createMemberReader, createStewardshipMonday, runStewardship, type MailchimpMember, type StewardshipMonday } from './run';
import type { StewardshipPerson } from './plan';
import type { StewardshipConfig } from '../types';
import type { BatchSkipContext } from '../writeSwitch';
import type { WriteMode } from '../flags';
import type { GraphQLRequest } from '../consent/sources';

const settings: StewardshipConfig = {
  boardId: 100,
  columns: {
    email: 'email', label: 'label', membershipStatus: 'ms', membershipTier: 'tier', memberType: 'type',
    memberSince: 'since', memberUntil: 'until', hasActiveRecurringGift: 'recurring', doNotSolicit: 'dns',
  },
  plan: {
    labels: {
      welcomeDayAfter: 'Welcome: day after', welcome3Weeks: 'Welcome: 3 weeks',
      renewal3Weeks: 'Renewal: 3 weeks before', renewal1Week: 'Renewal: 1 week before', renewalDayOf: 'Renewal: day of',
    },
    activeStatusValue: 'Active', lifetimeTierValue: 'Lifetime', newMemberTypeValue: 'New', catchUpDays: 2, renewalMonthsEarly: 0,
  },
  renewalOptOutTag: 'renewal-opt-out',
  renewalInterest: 'r1',
  welcomeInterest: null,
  maxWritesPerRun: 10,
};
const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'mailchimp-sync', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });
// 2026-12-01 09:00 Pacific.
const now = () => new Date('2026-12-01T17:00:00Z');

const base: StewardshipPerson = {
  itemId: '1', email: 'due@x.org', label: '', membershipStatus: 'Active', membershipTier: 'Member', memberType: 'Continuing',
  memberSince: '2025-12-22', memberUntil: '2026-12-22', hasActiveRecurringGift: false, doNotSolicit: false,
};
const people: StewardshipPerson[] = [
  base,                                                                                      // renewal, 3 weeks
  { ...base, itemId: '2', email: 'optout@x.org' },                                           // renewal, opted out
  { ...base, itemId: '3', email: 'renewed@x.org', memberUntil: '2027-12-01', label: 'Renewal: day of' }, // clear
  { ...base, itemId: '4', email: 'new@x.org', memberType: 'New', memberSince: '2026-11-30', memberUntil: '2027-11-30' }, // welcome
  { ...base, itemId: '5', email: 'quiet@x.org', memberUntil: '2027-06-01' },                 // nothing
];
const subscribed: MailchimpMember = { status: 'subscribed', tags: [], interests: { r1: true } };
const members: Record<string, MailchimpMember | null> = {
  'due@x.org': subscribed,
  'optout@x.org': { ...subscribed, tags: ['renewal-opt-out'] },
  'new@x.org': { ...subscribed, interests: { r1: false } },
};

const monday = (): StewardshipMonday & { writeLabel: ReturnType<typeof vi.fn> } => ({
  readPeople: vi.fn(async () => people),
  writeLabel: vi.fn(async () => undefined),
});
const deps = (m: StewardshipMonday, extra = {}) => ({
  settings, monday: m, readMember: async (email: string) => members[email] ?? null, isOutage: () => false, now, ...extra,
});

describe('checkMember', () => {
  const renewal = { itemId: '1', email: 'a', label: 'x', kind: 'renewal' as const };
  const welcome = { ...renewal, kind: 'welcome' as const };
  it('sends only to subscribed members who have not opted out of that kind', () => {
    expect(checkMember(subscribed, renewal, settings)).toBe('send');
    expect(checkMember(null, renewal, settings)).toBe('not-in-mailchimp');
    expect(checkMember({ ...subscribed, status: 'unsubscribed' }, welcome, settings)).toBe('not-subscribed');
    expect(checkMember({ ...subscribed, tags: ['renewal-opt-out'] }, renewal, settings)).toBe('renewal-opt-out');
    expect(checkMember({ ...subscribed, tags: ['renewal-opt-out'] }, welcome, settings)).toBe('send');
    expect(checkMember({ ...subscribed, interests: { r1: false } }, renewal, settings)).toBe('unticked');
    expect(checkMember({ ...subscribed, interests: {} }, renewal, settings)).toBe('unticked');
    expect(checkMember({ ...subscribed, interests: { r1: false } }, renewal, { ...settings, renewalInterest: null })).toBe('send');
  });
});

describe('runStewardship', () => {
  it('sets due labels, clears renewed ones, and holds back opt-outs', async () => {
    const m = monday();
    const summary = await runStewardship(gate('on'), deps(m));
    expect(summary).toMatchObject({ outcome: 'done', people: 5, planned: 4, renewal: 1, welcome: 1, cleared: 1, optedOut: 1, failed: 0 });
    expect(m.writeLabel.mock.calls.map(([, w]) => [w.itemId, w.label])).toEqual([
      ['1', 'Renewal: 3 weeks before'],
      ['3', ''],
      ['4', 'Welcome: day after'],
    ]);
  });

  it('writes nothing under off, and skips the day under hold', async () => {
    const dry = monday();
    expect(await runStewardship(gate('off'), deps(dry))).toMatchObject({ dryRun: true, renewal: 1, welcome: 1, cleared: 1 });
    expect(dry.writeLabel).not.toHaveBeenCalled();
    const held = monday();
    expect((await runStewardship(gate('hold'), deps(held))).outcome).toBe('skipped');
    expect(held.readPeople).not.toHaveBeenCalled();
  });

  it('is off without settings, and writes nothing on a failed read', async () => {
    expect((await runStewardship(gate('on'), deps(monday(), { settings: null }))).outcome).toBe('disabled');
    const m = monday();
    m.readPeople = vi.fn(async () => { throw new Error('boom'); });
    expect((await runStewardship(gate('on'), deps(m))).outcome).toBe('read-failed');
    expect(m.writeLabel).not.toHaveBeenCalled();
  });

  it('caps writes per run and stops at an outage', async () => {
    expect(await runStewardship(gate('on'), deps(monday(), { settings: { ...settings, maxWritesPerRun: 1 } }))).toMatchObject({ renewal: 1, deferred: 3 });
    const m = monday();
    m.writeLabel = vi.fn(async () => { throw new Error('429'); });
    expect(await runStewardship(gate('on'), deps(m, { isOutage: () => true }))).toMatchObject({ renewal: 0, deferred: 4 });
  });

  it('counts a non-outage failure and carries on', async () => {
    const m = monday();
    m.writeLabel = vi.fn().mockRejectedValueOnce(new Error('bad')).mockResolvedValue(undefined);
    expect(await runStewardship(gate('on'), deps(m))).toMatchObject({ failed: 1, cleared: 1, welcome: 1 });
  });
});

describe('createMemberReader', () => {
  const opts = (fetchFn: typeof fetch) => ({ fetchFn, apiBaseUrl: 'https://us9.api.mailchimp.com/3.0', apiKey: 'k-us9', audienceId: 'aud' });
  it('reads status, tag names and interests, and null for a 404', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 'subscribed', tags: [{ id: 1, name: 't' }], interests: { r1: true } })));
    expect(await createMemberReader(opts(fetchFn as unknown as typeof fetch))('A@x.org')).toEqual({ status: 'subscribed', tags: ['t'], interests: { r1: true } });
    const url = String((fetchFn.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/lists/aud/members/');
    expect(url).not.toContain('x.org');
    const missing = vi.fn(async () => new Response('{}', { status: 404 }));
    expect(await createMemberReader(opts(missing as unknown as typeof fetch))('a@x.org')).toBeNull();
    const broken = vi.fn(async () => new Response('{}', { status: 500 }));
    await expect(createMemberReader(opts(broken as unknown as typeof fetch))('a@x.org')).rejects.toThrow('HTTP 500');
  });
});

describe('createStewardshipMonday', () => {
  const ids = Object.values(settings.columns);
  const row = (id: string, values: Record<string, string>) => ({
    id, column_values: ids.map((col) => ({ id: col, text: values[col] ?? '', ...(col === 'email' ? { email: values.email ?? '' } : {}) })),
  });

  it('reads every page into people', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ boards: [{ items_page: { cursor: 'c1', items: [row('1', { email: 'a@x.org', ms: 'Active', recurring: 'v', until: '2026-12-22' })] } }] })
      .mockResolvedValueOnce({ next_items_page: { cursor: null, items: [row('2', { dns: 'v', label: 'Renewal: day of' })] } });
    const out = await createStewardshipMonday(request as unknown as GraphQLRequest).readPeople(settings);
    expect(out).toEqual([
      { ...base, itemId: '1', email: 'a@x.org', membershipTier: '', memberType: '', memberSince: '', hasActiveRecurringGift: true },
      { ...base, itemId: '2', email: '', label: 'Renewal: day of', membershipStatus: '', membershipTier: '', memberType: '', memberSince: '', memberUntil: '', doNotSolicit: true },
    ]);
  });

  it('fails loudly on a mistyped column id', async () => {
    const request = vi.fn().mockResolvedValueOnce({ boards: [{ items_page: { cursor: null, items: [{ id: '1', column_values: [] }] } }] });
    await expect(createStewardshipMonday(request as unknown as GraphQLRequest).readPeople(settings)).rejects.toThrow('has no column');
  });

  it('sets a label by its text, and clears with an empty string', async () => {
    const request = vi.fn(async () => ({}));
    const m = createStewardshipMonday(request as unknown as GraphQLRequest);
    await m.writeLabel(settings, { itemId: '9', email: 'a', label: 'Renewal: day of', kind: 'renewal' });
    await m.writeLabel(settings, { itemId: '9', email: 'a', label: '', kind: 'clear' });
    const vars = request.mock.calls.map((c) => (c as unknown[])[1] as { v: string });
    expect(JSON.parse(vars[0]!.v)).toEqual({ label: { label: 'Renewal: day of' } });
    expect(JSON.parse(vars[1]!.v)).toEqual({ label: '' });
  });
});
