import { describe, it, expect } from 'vitest';
import recorded from '../test/fixtures/cronRuns.json';
import queue from '../test/fixtures/queue.json';
import { cloudflareApi, CloudflareApiError } from './cloudflare';

// cronRuns.json is recorded from the live account (2026-11-23 08:30-10:05 UTC). The Queues shapes
// follow Cloudflare's docs (`GET /queues` and `GET /queues/{id}/metrics`).

const ACCOUNT = 'acct';
const NOW = new Date('2026-11-17T19:00:00Z');
type Call = { url: string; init: RequestInit | undefined };

function stub(routes: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return routes(url, init);
  }) as typeof fetch;
  return { calls, fetcher };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const row = (scriptName: string, datetimeMinute: string, requests = 1, sampleInterval = 1) => ({
  sum: { requests },
  avg: { sampleInterval },
  dimensions: { scriptName, datetimeMinute },
});
const gql = (rows: unknown) => ({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } }, errors: null });

describe('cronRuns', () => {
  const SINCE = new Date('2026-11-09T19:00:00Z');

  it('reads the recorded live response', async () => {
    const api = cloudflareApi(ACCOUNT, 'tok', stub(() => json(recorded)).fetcher, () => NOW);
    const runs = await api.cronRuns(['svbc-funraise-sync'], SINCE);
    expect(runs).toHaveLength(9);
    expect(runs).toContainEqual({ script: 'svbc-funraise-sync', at: new Date('2026-11-23T09:00:00Z'), count: 2 });
  });

  it('asks once for cron invocations of the named scripts over the whole window', async () => {
    const { fetcher, calls } = stub(() => json(gql([row('svbc-a', '2026-11-17T18:00:00Z')])));
    await cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW).cronRuns(['svbc-a', 'svbc-b'], SINCE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    const body = JSON.parse(String(calls[0]!.init!.body)) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain('eventType: "cron"');
    expect(body.variables).toEqual({
      accountTag: ACCOUNT,
      scripts: ['svbc-a', 'svbc-b'],
      since: SINCE.toISOString(),
      until: NOW.toISOString(),
    });
  });

  it('undoes sampling: 10 estimated requests at interval 10 is one observed run', async () => {
    const api = cloudflareApi(ACCOUNT, 'tok', stub(() => json(gql([row('svbc-a', '2026-11-17T17:10:00Z', 10, 10)]))).fetcher, () => NOW);
    expect((await api.cronRuns(['svbc-a'], SINCE))[0]!.count).toBe(1);
  });

  it('throws when the response hits the row limit (older runs may be cut off)', async () => {
    const rows = Array.from({ length: 10_000 }, () => row('svbc-a', '2026-11-17T18:00:00Z'));
    const api = cloudflareApi(ACCOUNT, 'tok', stub(() => json(gql(rows))).fetcher, () => NOW);
    await expect(api.cronRuns(['svbc-a'], SINCE)).rejects.toThrow(/limit/);
  });

  it.each([
    ['GraphQL errors', { data: null, errors: [{ message: 'not authorized' }] }],
    ['no rows array', gql(undefined)],
    ['an unreadable minute', gql([row('svbc-a', 'yesterday')])],
    ['a missing script name', gql([{ ...row('svbc-a', '2026-11-17T18:00:00Z'), dimensions: { datetimeMinute: '2026-11-17T18:00:00Z' } }])],
    ['a missing request count', gql([{ ...row('svbc-a', '2026-11-17T18:00:00Z'), sum: {} }])],
  ])('throws CloudflareApiError on %s', async (_name, body) => {
    const api = cloudflareApi(ACCOUNT, 'tok', stub(() => json(body)).fetcher, () => NOW);
    await expect(api.cronRuns(['svbc-a'], SINCE)).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe('queueBacklog', () => {
  const routes = (url: string) => (url.endsWith('/queues?per_page=100') ? json(queue.list) : json(queue.metrics));

  it('returns count and oldest age', async () => {
    const { fetcher, calls } = stub(routes);
    const api = cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW);
    const backlog = await api.queueBacklog('funraise-sync-writes');
    expect(backlog.count).toBe(4);
    expect(backlog.oldestAgeHours).toBeCloseTo((NOW.getTime() - 1795442400000) / 3_600_000, 5);
    expect(calls.map((c) => c.url)).toContain(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/queues/q-funraise/metrics`);
  });

  it('lists queues once per client', async () => {
    const { fetcher, calls } = stub(routes);
    const api = cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW);
    await api.queueBacklog('funraise-sync-writes');
    await api.queueBacklog('eventbrite-sync-writes');
    expect(calls.filter((c) => c.url.endsWith('/queues?per_page=100'))).toHaveLength(1);
  });

  it('reports an empty queue with null age', async () => {
    const emptyMetrics = { success: true, errors: [], result: { backlog_count: 0, backlog_bytes: 0, oldest_message_timestamp_ms: 0 } };
    const api = cloudflareApi(ACCOUNT, 'tok', stub((u) => (u.endsWith('/queues?per_page=100') ? json(queue.list) : json(emptyMetrics))).fetcher, () => NOW);
    expect(await api.queueBacklog('funraise-sync-writes')).toEqual({ count: 0, oldestAgeHours: null });
  });

  it('throws CloudflareApiError for a non-empty queue with no oldest-message timestamp', async () => {
    const noTimestamp = { success: true, errors: [], result: { backlog_count: 5, backlog_bytes: 10 } };
    const api = cloudflareApi(ACCOUNT, 'tok', stub((u) => (u.endsWith('/queues?per_page=100') ? json(queue.list) : json(noTimestamp))).fetcher, () => NOW);
    await expect(api.queueBacklog('funraise-sync-writes')).rejects.toBeInstanceOf(CloudflareApiError);
  });

  it('throws CloudflareApiError for an unknown queue name', async () => {
    const api = cloudflareApi(ACCOUNT, 'tok', stub(routes).fetcher, () => NOW);
    await expect(api.queueBacklog('no-such-queue')).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe('transport', () => {
  it('throws CloudflareApiError on non-2xx and on malformed JSON', async () => {
    const down = cloudflareApi(ACCOUNT, 'tok', stub(() => new Response('bad gateway', { status: 502 })).fetcher, () => NOW);
    await expect(down.cronRuns(['svbc-x'], NOW)).rejects.toBeInstanceOf(CloudflareApiError);
    const garbled = cloudflareApi(ACCOUNT, 'tok', stub(() => new Response('{not json', { status: 200 })).fetcher, () => NOW);
    await expect(garbled.queueBacklog('funraise-sync-writes')).rejects.toBeInstanceOf(CloudflareApiError);
  });

  it('sends the bearer token and a timeout signal', async () => {
    const { fetcher, calls } = stub(() => json(recorded));
    await cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW).cronRuns(['svbc-x'], NOW);
    expect(new Headers(calls[0]!.init!.headers).get('authorization')).toBe('Bearer tok');
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });
});

// Shapes per Cloudflare's API reference: Workers > Domains > List
// (developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/) and
// Workers > Routes > List (developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/).
describe('customDomains and zoneRoutes', () => {
  const ok = (result: unknown) => json({ success: true, errors: [], result });

  it('lists the zone\'s Custom Domains', async () => {
    const { fetcher, calls } = stub(() =>
      ok([{ id: 'd1', hostname: 'member.example.org', service: 'svbc-member-portal', environment: 'production', zone_id: 'z1', zone_name: 'example.org' }]),
    );
    const domains = await cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW).customDomains('example.org');
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/workers/domains?zone_name=example.org');
    expect(domains).toEqual([{ hostname: 'member.example.org', service: 'svbc-member-portal', zoneId: 'z1' }]);
  });

  it('lists the zone\'s routes; a route without a script runs no Worker', async () => {
    const { fetcher, calls } = stub(() => ok([{ id: 'r1', pattern: 'example.org/a/*', script: 'svbc-a' }, { id: 'r2', pattern: 'example.org/b' }]));
    const routes = await cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW).zoneRoutes('z1');
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/zones/z1/workers/routes');
    expect(routes).toEqual([{ pattern: 'example.org/a/*', script: 'svbc-a' }, { pattern: 'example.org/b', script: null }]);
  });

  it('a refused or malformed answer throws', async () => {
    const refused = cloudflareApi(ACCOUNT, 'tok', stub(() => json({ success: false, errors: [{ code: 10000 }] }, 403)).fetcher);
    await expect(refused.customDomains('example.org')).rejects.toBeInstanceOf(CloudflareApiError);
    const odd = cloudflareApi(ACCOUNT, 'tok', stub(() => ok([{ hostname: 'x' }])).fetcher);
    await expect(odd.customDomains('example.org')).rejects.toThrow('unexpected domain entry');
    await expect(cloudflareApi(ACCOUNT, 'tok', stub(() => ok({})).fetcher).zoneRoutes('z1')).rejects.toThrow('not a list');
  });
});
