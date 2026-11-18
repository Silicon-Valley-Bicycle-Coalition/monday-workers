// Read-only lookups shared by the rows of one queue batch (GL#101). A disbursement's rows share one
// company and one disbursement, so the Organization, its Affiliations and Employer matches, and the
// disbursement record are each read once per batch instead of once per row.
//
// The promise is cached, so concurrent callers share one load. A rejected load is forgotten, so a
// later row retries it rather than inheriting the failure. Lives only as long as the batch: nothing
// here is invalidated, so it must never outlive one queue() call.
export class BatchLookups {
  private readonly cache = new Map<string, Promise<unknown>>();

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) return hit as Promise<T>;
    const pending = load();
    this.cache.set(key, pending);
    pending.catch(() => {
      if (this.cache.get(key) === pending) this.cache.delete(key);
    });
    return pending;
  }
}
