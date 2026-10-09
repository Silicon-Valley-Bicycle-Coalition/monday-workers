import type { ItemPayload } from '../transform/types.js';
import { fiscalYearLoadOrder } from '../transform/schedule.js';

/** Monday write requests one load path issues for a fresh load (empty ledger, no failures). */
export interface PathCounts {
  /** create_item requests (each carries 1 mutation old-style, up to batchSize new-style). */
  createRequests: number;
  /** Separate change_multiple_column_values mutations, one per link with a migrated target. */
  linkMutations: number;
  /** Requests those link mutations travel in (aliased batchSize to a request since #50). */
  linkRequests: number;
  /** Links set inside create_item instead (#22). */
  inlineLinks: number;
  archives: number;
  /** Requests the archives travel in (aliased batchSize to a request since #50). */
  archiveRequests: number;
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

  // Links and archives batch within a phase: all the non-donation boards' separate links go in
  // one pass, each donation fiscal year batches its own links and its own archives. (A link
  // that load defers to a later fiscal year is counted in its source's group, a few requests off.)
  const perGroup = (n: number) => Math.ceil(n / opts.batchSize);
  let items = 0, links = 0, inline = 0, batches = 0, archives = 0, archiveRequests = 0;
  let linkRequests = 0, nonDonationSeparate = 0;
  const created = new Set<string>();
  for (const group of groups) {
    const unique = [...new Map(group.map((p) => [p.sfId, p])).values()];
    const isDonationYear = unique.length > 0 && unique.every((p) => p.board === 'donations');
    items += unique.length;
    batches += Math.ceil(unique.length / opts.batchSize);
    let groupArchives = 0, groupSeparate = 0;
    for (const p of unique) {
      if (p.archive) groupArchives++;
      for (const link of p.links ?? []) {
        const targets = link.targetSfIds.filter((t) => expected.has(t));
        if (targets.length === 0) continue; // skipped by design either way
        links++;
        if (opts.inlineLinks && targets.every((t) => created.has(t))) inline++;
        else groupSeparate++;
      }
    }
    archives += groupArchives;
    archiveRequests += perGroup(groupArchives);
    if (isDonationYear) linkRequests += perGroup(groupSeparate);
    else nonDonationSeparate += groupSeparate;
    for (const p of unique) created.add(p.sfId);
  }
  linkRequests += perGroup(nonDonationSeparate);
  return {
    items,
    old: { createRequests: items, linkMutations: links, inlineLinks: 0, linkRequests: links,
      archives, archiveRequests: archives, requests: items + links + archives },
    new: { createRequests: batches, linkMutations: links - inline, inlineLinks: inline, linkRequests,
      archives, archiveRequests, requests: batches + linkRequests + archiveRequests },
  };
}

/**
 * Monday runs mutations one at a time account-wide (#50: ~55/min flat for links and archives at
 * pool sizes 1-12 and across boards, latency growing with the number in flight), so wall-clock is
 * a sum, not a division by pool size: every request pays `requestMs` once and every mutation in it
 * pays its own type's cost. Defaults are measured on the full-size Donations (sandbox v3) board:
 * archives 1.9 s alone / 8.7 s per 10 → 1.1 s + 0.76 s each; links 1.6 s / 7.9 s → 0.9 s + 0.70 s
 * each. Creates: the 1.53 s pre-#22 per-create rate and ~110 items/min at batch 10 give 1.1 s +
 * 0.43 s each, inline links included.
 */
export interface TimingAssumptions {
  /** Per-request overhead, paid once however many mutations are aliased into it. */
  requestMs: number;
  /** Per create_item mutation (any inline links ride along). */
  createMs: number;
  /** Per separate change_multiple_column_values mutation. */
  linkMs: number;
  /** Per archive_item mutation. */
  archiveMs: number;
}

export const DEFAULT_TIMING: TimingAssumptions = { requestMs: 1100, createMs: 435, linkMs: 700, archiveMs: 760 };

/** old = R·requests + creates·c + links·l + archives·a;  new the same with its own counts. */
export function estimateHours(e: LoadEstimate, t: TimingAssumptions): { oldHours: number; newHours: number } {
  const ms = (c: PathCounts) =>
    c.requests * t.requestMs + e.items * t.createMs + c.linkMutations * t.linkMs + c.archives * t.archiveMs;
  return { oldHours: ms(e.old) / 3.6e6, newHours: ms(e.new) / 3.6e6 };
}

export function formatEstimate(e: LoadEstimate, t: TimingAssumptions & { batchSize: number }): string {
  const { oldHours, newHours } = estimateHours(e, t);
  const h = (n: number) => n.toFixed(1);
  return [
    'load[dry-run]: write plan for a fresh load (empty ledger, no failures):',
    `  old (default / --sequential): ${e.old.createRequests} create_item + ${e.old.linkMutations} link + ` +
      `${e.old.archives} archive = ${e.old.requests} requests`,
    `  new (--batched): ${e.new.createRequests} create requests (${e.items} create_item, ${e.new.inlineLinks} links inline) + ` +
      `${e.new.linkMutations} link in ${e.new.linkRequests} requests + ${e.new.archives} archive in ` +
      `${e.new.archiveRequests} requests = ${e.new.requests} requests`,
    `  est. wall-clock: old ≈ ${h(oldHours)} h, new ≈ ${h(newHours)} h ` +
      `(${t.requestMs} ms per request + ${t.createMs} per create, ${t.linkMs} per link, ${t.archiveMs} per archive; ` +
      `batch ${t.batchSize})`,
    '  Monday runs mutations one at a time account-wide, so pool size does not change this: time = ' +
      'requests·R + creates·c + links·l + archives·a. Override with --request-ms / --create-ms / ' +
      '--link-ms / --archive-ms; complexity-budget waits are not modelled',
  ].join('\n');
}
