import type { ItemPayload } from '../transform/types.js';
import { fiscalYearLoadOrder } from '../transform/schedule.js';

/** Monday write requests one load path issues for a fresh load (empty ledger, no failures). */
export interface PathCounts {
  /** create_item requests (each carries 1 mutation old-style, up to batchSize new-style). */
  createRequests: number;
  /** Separate change_multiple_column_values requests, one per link with a migrated target. */
  linkMutations: number;
  /** Links set inside create_item instead (#22). */
  inlineLinks: number;
  archives: number;
  requests: number;
}

export interface LoadEstimate { items: number; old: PathCounts; new: PathCounts }

/**
 * Counts what `load` would send for `payloads` on a fresh run, pre-#22 (`--sequential`) vs the
 * batched path. Mirrors load's phase order: every non-donation board in `boardKeys` order, then
 * donations per fiscal year oldest first. A link is inlinable only when every target it would
 * write belongs to an EARLIER group — the same "already ledgered, nothing pending" rule
 * load/inline.ts applies at run time (items in one group are created concurrently).
 */
export function estimateLoad(payloads: ItemPayload[], boardKeys: string[],
  opts: { batchSize: number; inlineLinks: boolean }): LoadEstimate {
  const expected = new Set(payloads.map((p) => p.sfId));
  const groups: ItemPayload[][] = [];
  for (const key of boardKeys) {
    if (key === 'donations') continue;
    groups.push(payloads.filter((p) => p.board === key));
  }
  const donations = payloads.filter((p) => p.board === 'donations');
  const fyOf = (p: ItemPayload) => String(p.columns['Fiscal Year Ending'] ?? '');
  for (const fy of fiscalYearLoadOrder(new Set(donations.map(fyOf)))) {
    groups.push(donations.filter((p) => fyOf(p) === fy));
  }

  let items = 0, links = 0, inline = 0, batches = 0, archives = 0;
  const created = new Set<string>();
  for (const group of groups) {
    const unique = [...new Map(group.map((p) => [p.sfId, p])).values()];
    items += unique.length;
    batches += Math.ceil(unique.length / opts.batchSize);
    for (const p of unique) {
      if (p.archive) archives++;
      for (const link of p.links ?? []) {
        const targets = link.targetSfIds.filter((t) => expected.has(t));
        if (targets.length === 0) continue; // skipped by design either way
        links++;
        if (opts.inlineLinks && targets.every((t) => created.has(t))) inline++;
      }
    }
    for (const p of unique) created.add(p.sfId);
  }
  return {
    items,
    old: { createRequests: items, linkMutations: links, inlineLinks: 0, archives,
      requests: items + links + archives },
    new: { createRequests: batches, linkMutations: links - inline, inlineLinks: inline, archives,
      requests: batches + links - inline + archives },
  };
}

export interface TimingAssumptions {
  /** Observed wall-clock per single-mutation request. */
  latencyMs: number;
  /** Extra time each additional aliased create_item adds to one request (measure in sandbox). */
  aliasMs: number;
  /** Create (and archive) requests in flight. */
  concurrency: number;
  /** Link requests in flight (both paths). */
  linkConcurrency: number;
}

/**
 * old = (C + A)·L + K·L/q
 * new = (B·L + (C − B)·α)/p + K′·L/q + A·L/p
 * C creates, B create requests, K / K′ separate link mutations, A archives, L latency,
 * α per-extra-alias cost, p create/archive concurrency, q link concurrency.
 */
export function estimateHours(e: LoadEstimate, t: TimingAssumptions): { oldHours: number; newHours: number } {
  const L = t.latencyMs;
  const oldMs = (e.old.createRequests + e.old.archives) * L + e.old.linkMutations * L / t.linkConcurrency;
  const newMs = (e.new.createRequests * L + (e.items - e.new.createRequests) * t.aliasMs) / t.concurrency +
    e.new.linkMutations * L / t.linkConcurrency + e.new.archives * L / t.concurrency;
  return { oldHours: oldMs / 3.6e6, newHours: newMs / 3.6e6 };
}

export function formatEstimate(e: LoadEstimate, t: TimingAssumptions & { batchSize: number }): string {
  const { oldHours, newHours } = estimateHours(e, t);
  const h = (n: number) => n.toFixed(1);
  return [
    'load[dry-run]: write plan for a fresh load (empty ledger, no failures):',
    `  old (default / --sequential): ${e.old.createRequests} create_item + ${e.old.linkMutations} link + ` +
      `${e.old.archives} archive = ${e.old.requests} requests`,
    `  new (--batched): ${e.new.createRequests} create requests (${e.items} create_item, ${e.new.inlineLinks} links inline) + ` +
      `${e.new.linkMutations} link + ${e.new.archives} archive = ${e.new.requests} requests`,
    `  est. wall-clock: old ≈ ${h(oldHours)} h, new ≈ ${h(newHours)} h ` +
      `(L=${t.latencyMs} ms/request, +${t.aliasMs} ms per extra alias, batch ${t.batchSize}, ` +
      `${t.concurrency} create+archive / ${t.linkConcurrency} link requests in flight)`,
    '  old = (C+A)·L + K·L/q;  new = (B·L + (C−B)·α)/p + K′·L/q + A·L/p — ' +
      'set --latency-ms / --alias-ms from a sandbox run; complexity-budget waits are not modelled',
  ].join('\n');
}
