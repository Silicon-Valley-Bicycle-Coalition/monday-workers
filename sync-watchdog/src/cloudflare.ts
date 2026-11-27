// The Cloudflare reads the watchdog needs. Everything that goes wrong (HTTP, GraphQL errors,
// unexpected shapes) is a CloudflareApiError, which src/checks.ts turns into "check failed" for
// that subject only. A check that couldn't run is never reported as healthy.

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10_000;

export class CloudflareApiError extends Error {
  override name = 'CloudflareApiError';
}

// Runs of one Worker started by a cron in one minute (UTC). Which cron isn't recorded; see src/cron.ts.
export interface CronRun {
  script: string;
  at: Date;
  count: number;
}

// A Worker Custom Domain (GET /accounts/{id}/workers/domains) and a zone's Workers route
// (GET /zones/{id}/workers/routes). `script` is null for a route that runs no Worker.
export interface CustomDomain {
  hostname: string;
  service: string;
  zoneId: string;
}
export interface ZoneRoute {
  pattern: string;
  script: string | null;
}

export interface CloudflareApi {
  cronRuns(scripts: string[], since: Date): Promise<CronRun[]>;
  queueBacklog(queueName: string): Promise<{ count: number; oldestAgeHours: number | null }>;
  // Needs Workers Scripts Read (account).
  customDomains(zoneName: string): Promise<CustomDomain[]>;
  // Needs Workers Routes Read on the zone.
  zoneRoutes(zoneId: string): Promise<ZoneRoute[]>;
}

// workersInvocationsAdaptive, not workersInvocationsScheduled: the latter has the cron expression
// but returned no rows at all for this account (checked 2026-11-24, 30 days back) while the crons
// were running. Needs only Account Analytics Read, and takes a 192 h range in one query.
const ROW_LIMIT = 10_000;
const CRON_RUNS_QUERY = `query CronRuns($accountTag: string!, $scripts: [string!], $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: ${ROW_LIMIT}, orderBy: [datetimeMinute_DESC], filter: { eventType: "cron", scriptName_in: $scripts, datetime_geq: $since, datetime_leq: $until }) {
        sum { requests }
        avg { sampleInterval }
        dimensions { scriptName datetimeMinute }
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

  async function rest(path: string, base = `${API}/accounts/${accountId}`): Promise<unknown> {
    const body = await call(`${base}${path}`);
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
    async cronRuns(scripts, since) {
      const body = await call(`${API}/graphql`, {
        method: 'POST',
        body: JSON.stringify({
          query: CRON_RUNS_QUERY,
          variables: { accountTag: accountId, scripts, since: since.toISOString(), until: now().toISOString() },
        }),
      });
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        throw new CloudflareApiError(`graphql: ${JSON.stringify(body.errors)}`);
      }
      const rows = (((body.data as Json | undefined)?.viewer as Json | undefined)?.accounts as Json[] | undefined)?.[0]
        ?.workersInvocationsAdaptive;
      if (!Array.isArray(rows)) throw new CloudflareApiError('graphql: unexpected response shape');
      if (rows.length >= ROW_LIMIT) throw new CloudflareApiError(`graphql: cron runs reached the ${ROW_LIMIT}-row limit`);
      return rows.map((row: Json): CronRun => {
        const { scriptName, datetimeMinute } = (row.dimensions ?? {}) as Json;
        const at = new Date(String(datetimeMinute));
        const requests = (row.sum as Json | undefined)?.requests;
        const interval = (row.avg as Json | undefined)?.sampleInterval;
        if (
          typeof scriptName !== 'string' ||
          Number.isNaN(at.getTime()) ||
          typeof requests !== 'number' ||
          typeof interval !== 'number' ||
          interval <= 0
        ) {
          throw new CloudflareApiError('graphql: unexpected cron run row');
        }
        // `requests` is scaled up by the sample interval (live: one run reported as 10); count what was observed.
        return { script: scriptName, at, count: Math.round(requests / interval) };
      });
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

    async customDomains(zoneName) {
      const path = `/workers/domains?zone_name=${encodeURIComponent(zoneName)}`;
      const result = await rest(path);
      if (!Array.isArray(result)) throw new CloudflareApiError(`${path}: result is not a list`);
      return result.map((d: Json): CustomDomain => {
        if (typeof d.hostname !== 'string' || typeof d.service !== 'string' || typeof d.zone_id !== 'string') {
          throw new CloudflareApiError(`${path}: unexpected domain entry`);
        }
        return { hostname: d.hostname, service: d.service, zoneId: d.zone_id };
      });
    },

    async zoneRoutes(zoneId) {
      const path = `/zones/${encodeURIComponent(zoneId)}/workers/routes`;
      const result = await rest(path, API);
      if (!Array.isArray(result)) throw new CloudflareApiError(`${path}: result is not a list`);
      return result.map((r: Json): ZoneRoute => {
        if (typeof r.pattern !== 'string') throw new CloudflareApiError(`${path}: unexpected route entry`);
        return { pattern: r.pattern, script: typeof r.script === 'string' && r.script !== '' ? r.script : null };
      });
    },
  };
}
