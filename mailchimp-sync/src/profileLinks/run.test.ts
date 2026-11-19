import { describe, it, expect, vi } from 'vitest';
import { adminBaseUrl, createProfileLinksMonday, planLinks, profileUrl, runProfileLinks, type ProfileItem, type ProfileLinksMonday } from './run';
import type { GraphQLRequest } from '../consent/sources';
import type { ProfileLinksConfig } from '../types';
import type { BatchSkipContext } from '../writeSwitch';
import type { WriteMode } from '../flags';

const ADMIN = 'https://us9.admin.mailchimp.com';
const settings: ProfileLinksConfig = { boardId: 100, emailColumn: 'email', linkColumn: 'link', maxWritesPerRun: 10 };
const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'mailchimp-sync', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });

const items: ProfileItem[] = [
  { itemId: '1', email: 'New@x.org', url: '' },                              // in Mailchimp, no link yet
  { itemId: '2', email: 'same@x.org', url: profileUrl(ADMIN, 22) },         // already right
  { itemId: '3', email: 'gone@x.org', url: profileUrl(ADMIN, 33) },         // left the audience
  { itemId: '4', email: '', url: '' },                                       // no address
];
const webIds = new Map([['new@x.org', 11], ['same@x.org', 22]]);

describe('profile links', () => {
  it('derives the admin host and the profile URL checked on 2026-11-18', () => {
    expect(adminBaseUrl('https://us9.api.mailchimp.com/3.0')).toBe(ADMIN);
    expect(profileUrl(ADMIN, 616612920)).toBe('https://us9.admin.mailchimp.com/lists/members/view?id=616612920');
  });

  it('plans only the links that differ, clearing one whose address left the audience', () => {
    expect(planLinks(items, webIds, ADMIN)).toEqual([
      { itemId: '1', url: profileUrl(ADMIN, 11) },
      { itemId: '3', url: null },
    ]);
  });

  const monday = (): ProfileLinksMonday & { writeLink: ReturnType<typeof vi.fn> } => ({
    readBoard: vi.fn(async () => items),
    writeLink: vi.fn(async () => undefined),
  });
  const deps = (m: ProfileLinksMonday, extra = {}) => ({
    settings, monday: m, readWebIds: async () => webIds, adminBaseUrl: ADMIN,
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

  it('never plans on a failed member read', async () => {
    const m = monday();
    const summary = await runProfileLinks(gate('on'), deps(m, { readWebIds: async () => { throw new Error('short'); } }));
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

  it('reads email and link values and writes the link column', async () => {
    const calls: Record<string, unknown>[] = [];
    const request = (async (query: string, vars: Record<string, unknown>) => {
      calls.push(vars);
      if (query.includes('mutation')) return { change_column_value: { id: '1' } };
      return { boards: [{ items_page: { cursor: null, items: [
        { id: '9', column_values: [{ id: 'email', text: 'x', email: 'p@x.org' }, { id: 'link', text: 'Mailchimp profile - u', url: 'https://u' }] },
      ] } }] };
    }) as GraphQLRequest;
    const client = createProfileLinksMonday(request);
    expect(await client.readBoard(settings)).toEqual([{ itemId: '9', email: 'p@x.org', url: 'https://u' }]);
    await client.writeLink(settings, { itemId: '9', url: 'https://v' });
    await client.writeLink(settings, { itemId: '9', url: null });
    expect(calls.slice(1).map((v) => v.value)).toEqual(['{"url":"https://v","text":"Mailchimp profile"}', '{}']);
  });
});
