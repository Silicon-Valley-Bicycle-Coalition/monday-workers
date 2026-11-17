import { describe, it, expect } from 'vitest';
import scheduled from '../test/fixtures/scheduled.json';
import queue from '../test/fixtures/queue.json';
import { cloudflareApi, CloudflareApiError } from './cloudflare';

// Fixture shapes follow Cloudflare's docs (GraphQL `workersInvocationsScheduled`; Queues
// `GET /queues` and `GET /queues/{id}/metrics`). Confirm them against the live account at deploy.

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

describe('lastScheduledRun', () => {
  it('returns the newest datetime', async () => {
    const { fetcher, calls } = stub(() => json(scheduled));
    const api = cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW);
    expect(await api.lastScheduledRun('svbc-funraise-sync', '0 * * * *', new Date('2026-11-17T00:00:00Z'))).toEqual(new Date('2026-11-17T18:00:01Z'));
    const body = JSON.parse(String(calls[0]!.init!.body)) as { query: string; variables: Record<string, string> };
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(body.query).toContain('workersInvocationsScheduled');
    expect(body.variables).toMatchObject({ accountTag: ACCOUNT, scriptName: 'svbc-funraise-sync', cron: '0 * * * *' });
  });

  it('returns null when there are no runs', async () => {
    const empty = { data: { viewer: { accounts: [{ workersInvocationsScheduled: [] }] } }, errors: null };
    const api = cloudflareApi(ACCOUNT, 'tok', stub(() => json(empty)).fetcher, () => NOW);
    expect(await api.lastScheduledRun('svbc-x', '0 * * * *', NOW)).toBeNull();
  });

  it('throws CloudflareApiError on GraphQL errors', async () => {
    const api = cloudflareApi(ACCOUNT, 'tok', stub(() => json({ data: null, errors: [{ message: 'not authorized' }] })).fetcher, () => NOW);
    await expect(api.lastScheduledRun('svbc-x', '0 * * * *', NOW)).rejects.toBeInstanceOf(CloudflareApiError);
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

  it('throws CloudflareApiError for an unknown queue name', async () => {
    const api = cloudflareApi(ACCOUNT, 'tok', stub(routes).fetcher, () => NOW);
    await expect(api.queueBacklog('no-such-queue')).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe('transport', () => {
  it('throws CloudflareApiError on non-2xx and on malformed JSON', async () => {
    const down = cloudflareApi(ACCOUNT, 'tok', stub(() => new Response('bad gateway', { status: 502 })).fetcher, () => NOW);
    await expect(down.lastScheduledRun('svbc-x', '0 * * * *', NOW)).rejects.toBeInstanceOf(CloudflareApiError);
    const garbled = cloudflareApi(ACCOUNT, 'tok', stub(() => new Response('{not json', { status: 200 })).fetcher, () => NOW);
    await expect(garbled.queueBacklog('funraise-sync-writes')).rejects.toBeInstanceOf(CloudflareApiError);
  });

  it('sends the bearer token and a timeout signal', async () => {
    const { fetcher, calls } = stub(() => json(scheduled));
    await cloudflareApi(ACCOUNT, 'tok', fetcher, () => NOW).lastScheduledRun('svbc-x', '0 * * * *', NOW);
    expect(new Headers(calls[0]!.init!.headers).get('authorization')).toBe('Bearer tok');
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });
});
