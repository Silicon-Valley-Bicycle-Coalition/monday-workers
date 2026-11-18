import type { MondayClient } from './client';
import type { DiscountOrganization } from '../types';

// Small keyed in-memory cache with a TTL. Stores only settled plain values, never a pending
// Promise: a module-level cache outlives the request that filled it, and in Workers awaiting a
// promise that belongs to another request's context can hang or throw once that request ends —
// so concurrent misses each load for themselves rather than sharing one in-flight fetch. A failed
// load is never cached (the next caller retries).
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) return hit.value;

    const value = await load();
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}

// The discount list (Organizations board, Discount Active checked) is the same for every donor
// and changes a few times a year, but was refetched — every page, 500+ rows — on each dashboard
// load (issue GL#31). Cached per isolate for 10 minutes:
// - in-isolate, not KV or the Cache API: no new binding to provision per environment (and keep
//   apart in config/split.test.ts), no extra subrequest on a hit, and the data is non-PII, so a
//   module-level cache shared across requests is safe. The cost is a cold isolate or another colo
//   refetching — fine at this traffic.
// - 10 minutes bounds how long a staff edit to a discount takes to show up.
export const DISCOUNT_CACHE_TTL_MS = 10 * 60_000;
export const discountOrganizationsCache = new TtlCache<DiscountOrganization[]>(DISCOUNT_CACHE_TTL_MS);

// A MondayClient whose getDiscountOrganizations goes through `cache`; every other method is the
// underlying client's own (prototype delegation, so `this` still resolves the client's state).
// `key` should identify the Organizations board, so two configs can never share an entry.
export function withCachedDiscounts(client: MondayClient, cache: TtlCache<DiscountOrganization[]>, key: string): MondayClient {
  const wrapped = Object.create(client) as MondayClient;
  wrapped.getDiscountOrganizations = () => cache.get(key, () => client.getDiscountOrganizations());
  return wrapped;
}
