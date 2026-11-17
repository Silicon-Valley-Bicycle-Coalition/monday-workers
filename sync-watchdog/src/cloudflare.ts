// The two Cloudflare reads the watchdog needs. Everything that goes wrong (HTTP, GraphQL errors,
// unexpected shapes) is a CloudflareApiError, which src/checks.ts turns into "check failed" for
// that subject only. A check that couldn't run is never reported as healthy.

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10_000;

export class CloudflareApiError extends Error {
  override name = 'CloudflareApiError';
}

export interface CloudflareApi {
  lastScheduledRun(script: string, cron: string, since: Date): Promise<Date | null>;
  queueBacklog(queueName: string): Promise<{ count: number; oldestAgeHours: number | null }>;
}

const SCHEDULED_QUERY = `query LastScheduledRun($accountTag: string!, $scriptName: string!, $cron: string!, $since: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsScheduled(limit: 1, orderBy: [datetime_DESC], filter: { scriptName: $scriptName, cron: $cron, datetime_geq: $since }) {
        datetime
      }
    }
  }
}`;

type Json = Record<string, unknown>;

export function cloudflareApi(
  accountId: string,
  token: string,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): CloudflareApi {
  async function call(url: string, init: RequestInit = {}): Promise<Json> {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudflareApiError(`${url}: request failed: ${err}`);
    }
    const text = await response.text();
    if (!response.ok) throw new CloudflareApiError(`${url}: HTTP ${response.status}`);
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new CloudflareApiError(`${url}: response is not JSON`);
    }
  }

  async function rest(path: string): Promise<unknown> {
    const body = await call(`${API}/accounts/${accountId}${path}`);
    if (body.success !== true) throw new CloudflareApiError(`${path}: ${JSON.stringify(body.errors ?? 'unsuccessful')}`);
    return body.result;
  }

  let queueIds: Promise<Map<string, string>> | null = null;
  function queueIdFor(name: string): Promise<Map<string, string>> {
    queueIds ??= rest('/queues?per_page=100').then((result) => {
      if (!Array.isArray(result)) throw new CloudflareApiError('/queues: result is not a list');
      return new Map(result.map((q: Json) => [String(q.queue_name), String(q.queue_id)]));
    });
    // A failed listing is retried on the next call rather than cached.
    queueIds.catch(() => {
      queueIds = null;
    });
    return queueIds;
  }

  return {
    async lastScheduledRun(script, cron, since) {
      const body = await call(`${API}/graphql`, {
        method: 'POST',
        body: JSON.stringify({
          query: SCHEDULED_QUERY,
          variables: { accountTag: accountId, scriptName: script, cron, since: since.toISOString() },
        }),
      });
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        throw new CloudflareApiError(`graphql: ${JSON.stringify(body.errors)}`);
      }
      const rows = (((body.data as Json | undefined)?.viewer as Json | undefined)?.accounts as Json[] | undefined)?.[0]
        ?.workersInvocationsScheduled;
      if (!Array.isArray(rows)) throw new CloudflareApiError('graphql: unexpected response shape');
      const first = rows[0] as Json | undefined;
      return first ? new Date(String(first.datetime)) : null;
    },

    async queueBacklog(queueName) {
      const id = (await queueIdFor(queueName)).get(queueName);
      if (id === undefined) throw new CloudflareApiError(`queue "${queueName}" not found`);
      const m = (await rest(`/queues/${id}/metrics`)) as Json | null;
      const count = m?.backlog_count;
      if (typeof count !== 'number') throw new CloudflareApiError(`queue "${queueName}": metrics missing backlog_count`);
      if (count === 0) return { count, oldestAgeHours: null };
      const oldest = m?.oldest_message_timestamp_ms;
      // A backlog we can't date is a failed check, never a healthy queue.
      if (typeof oldest !== 'number' || oldest <= 0) {
        throw new CloudflareApiError(`queue "${queueName}": ${count} messages but no oldest_message_timestamp_ms`);
      }
      return { count, oldestAgeHours: (now().getTime() - oldest) / 3_600_000 };
    },
  };
}
