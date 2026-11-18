import { describe, it, expect, vi } from 'vitest';
import { runRenewalDue } from './run';
import type { Config } from '../types';
import type { BatchSkipContext } from '../writeSwitch';
import type { WriteMode } from '../flags';

const config = {
  mailchimp: {
    apiBaseUrl: 'https://us1.api.mailchimp.com/3.0', audienceId: 'aud',
    mergeFields: { memberUntil: 'MEMBUNTIL' },
    tags: { activeMember: 'active-member' },
    renewalDue: { tag: 'renewal-due', daysBefore: 28 },
  },
} as unknown as Config;

const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'mailchimp-sync', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });
const now = () => new Date('2026-11-17T18:00:00Z');

function audience(members: unknown[], tagStatus = 204) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(null, { status: tagStatus });
    return new Response(JSON.stringify({ total_items: members.length, members }), { status: 200 });
  });
}
// The mocks stand in for fetch; its overloads don't accept a vi.fn type directly.
const asFetch = (f: unknown) => f as typeof fetch;
const member = (email: string, until: string, tags: string[]) => ({ email_address: email, status: 'subscribed', merge_fields: { MEMBUNTIL: until }, tags: tags.map((name) => ({ name })) });

describe('runRenewalDue', () => {
  it('adds and removes the tag under writes on', async () => {
    const fetchFn = audience([member('due@x.org', '2026-12-01', ['active-member']), member('renewed@x.org', '2027-12-01', ['active-member', 'renewal-due'])]);
    const summary = await runRenewalDue(gate('on'), { config, fetchFn: asFetch(fetchFn), apiKey: 'k-us1', now });
    expect(summary).toMatchObject({ outcome: 'done', members: 2, due: 1, added: 1, removed: 1, failed: 0, dryRun: false });
    const posts = fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init!.body as string));
    expect(posts).toEqual([{ tags: [{ name: 'renewal-due', status: 'active' }] }, { tags: [{ name: 'renewal-due', status: 'inactive' }] }]);
  });

  it('plans without writing under off, and skips under hold', async () => {
    const fetchFn = audience([member('due@x.org', '2026-12-01', ['active-member'])]);
    expect(await runRenewalDue(gate('off'), { config, fetchFn: asFetch(fetchFn), apiKey: 'k', now })).toMatchObject({ dryRun: true, due: 1, added: 0 });
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    const held = audience([]);
    expect((await runRenewalDue(gate('hold'), { config, fetchFn: asFetch(held), apiKey: 'k', now })).outcome).toBe('skipped');
    expect(held).not.toHaveBeenCalled();
  });

  it('writes nothing when the read fails, and counts failed tag writes', async () => {
    const down = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 503 }));
    expect((await runRenewalDue(gate('on'), { config, fetchFn: asFetch(down), apiKey: 'k', now })).outcome).toBe('read-failed');
    const rejecting = audience([member('due@x.org', '2026-12-01', ['active-member'])], 400);
    expect(await runRenewalDue(gate('on'), { config, fetchFn: asFetch(rejecting), apiKey: 'k', now })).toMatchObject({ added: 0, failed: 1 });
  });

  it('does nothing when renewalDue is not configured', async () => {
    const fetchFn = audience([]);
    const off = { ...config, mailchimp: { ...config.mailchimp, renewalDue: null } } as Config;
    expect((await runRenewalDue(gate('on'), { config: off, fetchFn: asFetch(fetchFn), apiKey: 'k', now })).outcome).toBe('disabled');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
