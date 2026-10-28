// donation-rollups' side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run
// versions of the consumer's and the custodian's deps. The recompute and the duties run unchanged
// against them, so a dry run reads Monday and D1 and computes every rollup, membership stamp and
// summary exactly as a live run would; only the last step — the Monday write, the fan-out enqueue,
// or the D1 bookkeeping that records it — is swapped out here.
//
// The D1 tables here are derived projections (ledger, links, annual summaries, custodian runs).
// A dry run refreshes none of them, so it also advances no custodian cursor; the next live run
// refreshes them from the same Monday reads.
import { readOnlyProxy, recordingProxy, type SkipContext } from './flags';
import type { ProcessBatchDeps } from './consumer/processBatch';
import type { CustodianDeps } from './custodian/custodian';
import type { PendingStore } from './db/pending';
import type { DonationLinksStore } from './db/links';
import type { GiftsStore } from './db/gifts';
import type { OwnerRecomputesStore } from './db/ownerRecomputes';
import type { AffiliationsStore } from './db/affiliations';
import type { VolunteerActivityStore } from './db/volunteerActivity';

// Everything a skip line needs except the delivery, which is per message (or per cron run).
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

const MONDAY_SINK = 'Monday';
const QUEUE_SINK = 'RECOMPUTE_QUEUE';

const PENDING_MUTATORS = ['upsertPending', 'updateStatus'] as const satisfies readonly (keyof PendingStore)[];
const LINKS_MUTATORS = ['upsertLink', 'bulkUpsert', 'deleteLink'] as const satisfies readonly (keyof DonationLinksStore)[];
const GIFTS_MUTATORS = ['refreshFacts', 'markRemoved', 'setSummaryItemId', 'markArchived', 'setTermStarts',
  'upsertAnnualSummaries', 'recordRun'] as const satisfies readonly (keyof GiftsStore)[];
const RECOMPUTES_MUTATORS = ['record', 'acquireLease', 'releaseLease'] as const satisfies readonly (keyof OwnerRecomputesStore)[];
const AFFILIATIONS_MUTATORS = ['upsert', 'bulkUpsert'] as const satisfies readonly (keyof AffiliationsStore)[];
const VOLUNTEER_MUTATORS = ['upsert', 'upsertMany', 'markRemoved'] as const satisfies readonly (keyof VolunteerActivityStore)[];

// readOnlyProxy drops a write to `undefined`; a mutator whose caller reads its result gets a
// stand-in result instead, so the recompute carries on to its Monday writes (and their skip
// lines) rather than crashing on `undefined.changed`.
function dryRunStore<T extends object>(store: T, mutators: readonly (keyof T)[], results: { [K in keyof T]?: T[K] } = {}): T {
  const readOnly = readOnlyProxy(store, mutators);
  return new Proxy(readOnly, {
    get: (target, prop, receiver) =>
      Object.prototype.hasOwnProperty.call(results, prop) ? results[prop as keyof T] : Reflect.get(target, prop, receiver),
  });
}

/**
 * The reverse index with every write dropped. upsertLink answers from a read of the stored link,
 * the way the live method would: a donation that moved still reports its previous owner, so the
 * recompute of the owner it left reaches the (recording) queue. It always reports the link as
 * just written, so a dry run never coalesces a recompute away.
 */
function dryRunLinksStore(store: DonationLinksStore): DonationLinksStore {
  return dryRunStore(store, LINKS_MUTATORS, {
    upsertLink: async (link, updatedAt) => {
      const existing = await store.getLinkForDonation(link.donationItemId);
      if (existing !== null && existing.ownerItemId !== link.ownerItemId) {
        return { changed: true, updatedAt, previousOwner: existing };
      }
      return { changed: existing === null || existing.ownerBoardId !== link.ownerBoardId, updatedAt };
    },
    bulkUpsert: async () => 0,
  });
}

// markRemoved reports "the ledger never knew the gift" (null): the removed gift's acting-for isn't
// readable without the write, so a dry-run detach recomputes the linked owner but not an
// affiliation only that gift fed.
function dryRunGiftsStore(store: GiftsStore): GiftsStore {
  return dryRunStore(store, GIFTS_MUTATORS, {
    refreshFacts: async () => ({ changed: 0 }),
    markRemoved: async () => null,
    upsertAnnualSummaries: async () => ({ changed: [] }),
  });
}

// As with markRemoved, a re-pointed registration's previous owner isn't readable without the
// write: the dry run recomputes the current attendee only.
function dryRunVolunteerStore(store: VolunteerActivityStore): VolunteerActivityStore {
  return dryRunStore(store, VOLUNTEER_MUTATORS, {
    upsert: async () => ({ previousOwner: null }),
    markRemoved: async () => null,
  });
}

/**
 * The pending store for a dry-run recompute: every write dropped except updateStatus(id,
 * 'dropped'), which reaches the real store. The consumer makes that one call per message it
 * dry-runs, so a delivery ingested live but consumed under `off` (an emergency stop) is closed
 * out instead of staying 'queued' — where the nightly requeue would re-send it as a live
 * recompute once writes are back on.
 */
function dryRunPendingStore(store: PendingStore): PendingStore {
  const readOnly = dryRunStore(store, PENDING_MUTATORS);
  return dryRunStore(readOnly, [], {
    updateStatus: async (donationItemId, status, patch) => {
      if (status === 'dropped') await store.updateStatus(donationItemId, status, patch);
    },
  });
}

export function dryRunConsumerDeps(deps: ProcessBatchDeps, ctx: SkipContext): ProcessBatchDeps {
  return {
    ...deps,
    pendingStore: dryRunPendingStore(deps.pendingStore),
    linksStore: dryRunLinksStore(deps.linksStore),
    giftsStore: dryRunGiftsStore(deps.giftsStore),
    // A dry run writes nothing to Monday, so it has no lost update to guard against: it never
    // waits on, or takes, an owner lease.
    recomputesStore: dryRunStore(deps.recomputesStore, RECOMPUTES_MUTATORS, { acquireLease: async () => true }),
    affiliationsStore: dryRunStore(deps.affiliationsStore, AFFILIATIONS_MUTATORS, { bulkUpsert: async () => 0 }),
    volunteerStore: dryRunVolunteerStore(deps.volunteerStore),
    mondayClient: recordingProxy(deps.mondayClient, MONDAY_SINK, {
      changeColumnValues: undefined,
      setItemDescription: undefined,
      createUpdate: undefined,
    }, ctx),
    // The owner a moved gift left is recorded, not enqueued: a dry run must not fan out.
    queue: deps.queue && recordingProxy(deps.queue, QUEUE_SINK, { send: undefined }, ctx),
  };
}

// The custodian's deps for a duty run that runDisposition allowed: live for `run`, proxied for
// `dry-run`. recordRun is dropped with the rest, so a dry run leaves custodian_runs — and with it
// every duty's cursor and dutiesForDate's continuation logic — exactly as the last live run did.
export function custodianDepsFor(disposition: 'run' | 'dry-run', deps: CustodianDeps, ctx: SkipContext): CustodianDeps {
  if (disposition === 'run') return deps;
  return {
    ...deps,
    gifts: dryRunGiftsStore(deps.gifts),
    pending: dryRunStore(deps.pending, PENDING_MUTATORS),
    volunteers: dryRunVolunteerStore(deps.volunteers),
    recomputes: dryRunStore(deps.recomputes, RECOMPUTES_MUTATORS),
    mondayClient: recordingProxy(deps.mondayClient, MONDAY_SINK, {
      archiveItem: undefined,
      createItem: function (): string {
        return `dry-run-${this.n}`;
      },
      changeColumnValues: undefined,
      createUpdate: undefined,
    }, ctx),
    queue: recordingProxy(deps.queue, QUEUE_SINK, { sendBatch: undefined }, ctx),
  };
}
