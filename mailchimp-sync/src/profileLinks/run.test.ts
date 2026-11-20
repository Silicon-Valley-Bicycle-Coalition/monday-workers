import { describe, it, expect, vi } from 'vitest';
import { adminBaseUrl, createProfileLinksMonday, planLinks, preferencesUrl, profileUrl, runProfileLinks, type MemberIds, type ProfileItem, type ProfileLinksMonday } from './run';
import type { GraphQLRequest } from '../consent/sources';
import type { ProfileLinksConfig } from '../types';
import type { BatchSkipContext } from '../writeSwitch';
import type { WriteMode } from '../flags';

const ADMIN = 'https://us9.admin.mailchimp.com';
const PAGE = 'https://bikesiliconvalley.us9.list-manage.com/profile?u=f5051c378a338d4fba23caa04&id=dfe12eec72';
const settings: ProfileLinksConfig = { boardId: 100, emailColumn: 'email', linkColumn: 'link', maxWritesPerRun: 10, preferences: null };
const withPrefs: ProfileLinksConfig = { ...settings, preferences: { column: 'prefs', pageUrl: PAGE } };
const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'mailchimp-sync', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });

const items: ProfileItem[] = [
  { itemId: '1', email: 'New@x.org', url: '', preferencesUrl: '' },                                          // in Mailchimp, no links yet
  { itemId: '2', email: 'same@x.org', url: profileUrl(ADMIN, 22), preferencesUrl: preferencesUrl(PAGE, 'bb') }, // already right
  { itemId: '3', email: 'gone@x.org', url: profileUrl(ADMIN, 33), preferencesUrl: preferencesUrl(PAGE, 'cc') }, // left the audience
  { itemId: '4', email: '', url: '', preferencesUrl: '' },                                                    // no address
];
const members: MemberIds = {
  webIds: new Map([['new@x.org', 11], ['same@x.org', 22]]),
  uniqueEmailIds: new Map([['new@x.org', 'aa'], ['same@x.org', 'bb']]),
};

describe('profile links', () => {
  it('derives the admin host and the profile URL checked on 2026-11-18', () => {
    expect(adminBaseUrl('https://us9.api.mailchimp.com/3.0')).toBe(ADMIN);
    expect(profileUrl(ADMIN, 616612920)).toBe('https://us9.admin.mailchimp.com/lists/members/view?id=616612920');
  });

  it("builds the hosted preferences page URL checked on 2026-11-20 from the member's unique_email_id", () => {
    expect(preferencesUrl(PAGE, '0647d7be1b')).toBe(`${PAGE}&e=0647d7be1b`);
  });

  it('plans only the profile links that differ, clearing one whose address left the audience', () => {
    expect(planLinks(items, members, ADMIN, null)).toEqual([
      { itemId: '1', kind: 'profile', url: profileUrl(ADMIN, 11) },
      { itemId: '3', kind: 'profile', url: null },
    ]);
  });

  it('plans preferences links alongside, when configured', () => {
    expect(planLinks(items, members, ADMIN, PAGE)).toEqual([
      { itemId: '1', kind: 'profile', url: profileUrl(ADMIN, 11) },
      { itemId: '1', kind: 'preferences', url: preferencesUrl(PAGE, 'aa') },
      { itemId: '3', kind: 'profile', url: null },
      { itemId: '3', kind: 'preferences', url: null },
    ]);
  });

  it('gives an archived member (a web_id but no unique_email_id) a profile link and no preferences link', () => {
    const archived: ProfileItem[] = [{ itemId: '5', email: 'arch@x.org', url: '', preferencesUrl: preferencesUrl(PAGE, 'old') }];
    const ids: MemberIds = { webIds: new Map([['arch@x.org', 55]]), uniqueEmailIds: new Map() };
    expect(planLinks(archived, ids, ADMIN, PAGE)).toEqual([
      { itemId: '5', kind: 'profile', url: profileUrl(ADMIN, 55) },
      { itemId: '5', kind: 'preferences', url: null },
    ]);
  });

  const monday = (): ProfileLinksMonday & { writeLink: ReturnType<typeof vi.fn> } => ({
    readBoard: vi.fn(async () => items),
    writeLink: vi.fn(async () => undefined),
  });
  const deps = (m: ProfileLinksMonday, extra = {}) => ({
    settings, monday: m, readMembers: async () => members, adminBaseUrl: ADMIN,
    isOutage: () => false, deadline: Date.now() + 60_000, ...extra,
  });

  it('writes and clears under on, nothing under off, and skips under hold', async () => {
    const m = monday();
    expect(await runProfileLinks(gate('on'), deps(m))).toMatchObject({ items: 4, planned: 2, written: 1, cleared: 1 });
    const dry = monday();
    expect(await runProfileLinks(gate('off'), deps(dry))).toMatchObject({ planned: 2, written: 0 });
    expect(dry.writeLink).not.toHaveBeenCalled();
    expect((await runProfileLinks(gate('hold'), deps(monday()))).outcome).toBe('skipped');
  });

  it('writes both kinds when preferences are configured', async () => {
    const m = monday();
    expect(await runProfileLinks(gate('on'), deps(m, { settings: withPrefs }))).toMatchObject({ planned: 4, written: 2, cleared: 2 });
    expect(m.writeLink).toHaveBeenCalledWith(withPrefs, { itemId: '1', kind: 'preferences', url: preferencesUrl(PAGE, 'aa') });
  });

  it('never plans on a failed member read', async () => {
    const m = monday();
    const summary = await runProfileLinks(gate('on'), deps(m, { readMembers: async () => { throw new Error('short'); } }));
    expect(summary.outcome).toBe('read-failed');
    expect(m.readBoard).not.toHaveBeenCalled();
  });

  it('caps writes per run and stops at an outage', async () => {
    const capped = await runProfileLinks(gate('on'), deps(monday(), { settings: { ...settings, maxWritesPerRun: 1 } }));
    expect(capped).toMatchObject({ written: 1, deferred: 1 });
    const m = monday();
    const outage = new Error('503');
    m.writeLink.mockRejectedValue(outage);
    expect(await runProfileLinks(gate('on'), deps(m, { isOutage: (e: unknown) => e === outage }))).toMatchObject({ written: 0, failed: 0, deferred: 2 });
    expect(m.writeLink).toHaveBeenCalledOnce();
  });

  const fakeRequest = (calls: Record<string, unknown>[], columnValues: Record<string, unknown>[]) => (async (query: string, vars: Record<string, unknown>) => {
    calls.push(vars);
    if (query.includes('mutation')) return { change_column_value: { id: '1' } };
    return { boards: [{ items_page: { cursor: null, items: [{ id: '9', column_values: columnValues }] } }] };
  }) as GraphQLRequest;

  it('reads email and link values and writes the link column', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = createProfileLinksMonday(fakeRequest(calls, [
      { id: 'email', text: 'x', email: 'p@x.org' }, { id: 'link', text: 'Mailchimp profile - u', url: 'https://u' },
    ]));
    expect(await client.readBoard(settings)).toEqual([{ itemId: '9', email: 'p@x.org', url: 'https://u', preferencesUrl: '' }]);
    expect(calls[0]!.columnIds).toEqual(['email', 'link']);
    await client.writeLink(settings, { itemId: '9', kind: 'profile', url: 'https://v' });
    await client.writeLink(settings, { itemId: '9', kind: 'profile', url: null });
    expect(calls.slice(1).map((v) => [v.columnId, v.value])).toEqual([['link', '{"url":"https://v","text":"Mailchimp profile"}'], ['link', '{}']]);
  });

  it('reads and writes the preferences column when configured', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = createProfileLinksMonday(fakeRequest(calls, [
      { id: 'email', text: 'x', email: 'p@x.org' }, { id: 'link', text: '', url: null }, { id: 'prefs', text: 'x', url: 'https://p' },
    ]));
    expect(await client.readBoard(withPrefs)).toEqual([{ itemId: '9', email: 'p@x.org', url: '', preferencesUrl: 'https://p' }]);
    expect(calls[0]!.columnIds).toEqual(['email', 'link', 'prefs']);
    await client.writeLink(withPrefs, { itemId: '9', kind: 'preferences', url: 'https://q' });
    expect([calls[1]!.columnId, calls[1]!.value]).toEqual(['prefs', '{"url":"https://q","text":"Email preferences"}']);
  });

  it('refuses a board missing the preferences column', async () => {
    const client = createProfileLinksMonday(fakeRequest([], [{ id: 'email', text: 'x', email: 'p@x.org' }, { id: 'link', text: '', url: null }]));
    await expect(client.readBoard(withPrefs)).rejects.toThrow(/no column "prefs"/);
  });
});
