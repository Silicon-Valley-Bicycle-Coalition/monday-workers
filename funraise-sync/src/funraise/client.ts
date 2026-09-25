// Funraise REST API, the slice this Worker reads: subscriptions. Base https://api.funraise.io,
// X-Api-Key auth (reference: https://funraise.stoplight.io). Verified live 2026-09-18: the list
// returns fixed pages of 10 selected by `page`, and honours a `q` expression for filtering and
// ordering (`updtime >= <ms> order by updtime asc`); exact-id and impossible filters behave.
// The webhook is the source for donations — the donation list ignores `q` — so nothing here
// reads donations or supporters.

// The fields the poller reads. Everything else on the row is passed through untouched to the
// mapper, which only looks at these.
export interface FunraiseSubscription {
  id: number | string;
  name?: string | null;
  status?: string | null;
  frequency?: string | null;
  sourceAmount?: number | null;
  currency?: string | null;
  nextPaymentDate?: number | null;
  lastPaymentDate?: number | null;
  cancelDate?: number | null;
  updtime?: number | null;
  cretime?: number | null;
  companyMatch?: { companyName?: string | null; companyId?: unknown; employeeEmail?: string | null } | null;
  form?: { id?: unknown; name?: string | null } | null;
  supporter?: Record<string, unknown> | null;
  [key: string]: unknown;
}

// The two keyset queries the poller pages with (#25; see src/subscriptions/poll.ts). Always
// page 0 — the position comes from the filter, never an offset.
export interface FunraiseClient {
  // `updtime > afterMs order by updtime asc`
  listSubscriptionsUpdatedAfter(afterMs: number): Promise<FunraiseSubscription[]>;
  // `updtime = updtimeMs and id > afterId order by id asc`
  listSubscriptionsAtUpdtime(updtimeMs: number, afterId: number): Promise<FunraiseSubscription[]>;
  getSubscription(id: string): Promise<FunraiseSubscription | null>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Funraise answers HTTP 500 to `updtime >= 0` (and to 1); values from 2001-09-09 up work
// (observed live 2026-09-18). Well before any Funraise data, so flooring a fresh cursor here
// changes nothing except that the first poll can run.
export const MIN_QUERYABLE_UPDTIME_MS = 1000000000000;

export class HttpFunraiseClient implements FunraiseClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  private async request(path: string, params?: Record<string, string>): Promise<Response> {
    const url = new URL(`/api/v1/${path}`, this.baseUrl);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
    });
  }

  async listSubscriptionsUpdatedAfter(afterMs: number): Promise<FunraiseSubscription[]> {
    return this.listSubscriptions(`updtime > ${Math.max(afterMs, MIN_QUERYABLE_UPDTIME_MS)} order by updtime asc`);
  }

  // NOTE: the `and` conjunction is the one piece of this query language not yet exercised against
  // the live API (2026-09-18 verified `>`, `>=`, `=`, `order by`, and exact id, each alone).
  // Confirm with one read-only probe before deploying — see README "Recurring gifts".
  async listSubscriptionsAtUpdtime(updtimeMs: number, afterId: number): Promise<FunraiseSubscription[]> {
    // Nothing is dated before the floor, and Funraise 500s on an updtime filter below it.
    if (updtimeMs < MIN_QUERYABLE_UPDTIME_MS) return [];
    return this.listSubscriptions(`updtime = ${updtimeMs} and id > ${Math.trunc(afterId)} order by id asc`);
  }

  private async listSubscriptions(q: string): Promise<FunraiseSubscription[]> {
    const res = await this.request('crm/subscription', { q, page: '0' });
    if (!res.ok) {
      throw new Error(`funraise api: list subscriptions failed with HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new Error('funraise api: list subscriptions expected an array');
    }
    return body as FunraiseSubscription[];
  }

  async getSubscription(id: string): Promise<FunraiseSubscription | null> {
    const res = await this.request(`crm/subscription/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`funraise api: get subscription ${id} failed with HTTP ${res.status}`);
    }
    return (await res.json()) as FunraiseSubscription;
  }
}
