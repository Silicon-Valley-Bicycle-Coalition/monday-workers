// benevity-import's side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run versions
// of the webhook routes' and the consumer's deps. The business logic runs unchanged against them;
// only the last step — the Monday write, or the D1 bookkeeping that records it — is swapped out.
import { readOnlyProxy, recordingProxy, stampFor, type SkipContext } from './flags';
import type { DisbursementStore } from './db/disbursements';
import type { RowStore } from './db/rows';
import type { MondayClient, MondayItem } from './monday/client';
import type { ProcessBatchDeps } from './consumer/processBatch';
import type { AppDeps } from './webhook/route';

// Everything a skip line needs except the delivery, which is per request (or per message).
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// Row-ledger writes a dry run must not make: a row marked 'written' or 'needs-review' against a
// placeholder worklist/Donation item id would survive the flip back to `on`, and a requeue would
// move a row out of the state staff left it in.
const ROW_STORE_MUTATORS = ['updateStatus', 'requeueRow', 'requeueDisbursementRows'] as const;

/**
 * A MondayClient that forwards reads and records each create/update/archive as a skip line. A
 * create resolves to a placeholder `{ id: 'dry-run-N' }` so the chained steps (a worklist item's
 * id, a Donation's id) still run; nothing persists that id (the stores below).
 */
export function dryRunMondayClient(client: MondayClient, ctx: SkipContext): MondayClient {
  return recordingProxy(client, 'Monday', {
    createItem: function (): MondayItem {
      return { id: `dry-run-${this.n}`, name: '' };
    },
    changeColumnValues: undefined,
    archiveItem: undefined,
  }, ctx);
}

/**
 * The disbursement ledger with `claimWorklistItemId` dropped. Dropped to undefined it would read
 * as "another delivery recorded its item first", and the route would then archive the (placeholder)
 * item as a duplicate; so it reports the claim as won, echoing the item id it was given.
 */
export function dryRunDisbursementStore(store: DisbursementStore): DisbursementStore {
  const readOnly = readOnlyProxy(store, ['claimWorklistItemId'] as const);
  return new Proxy(readOnly, {
    get: (target, prop, receiver) =>
      prop === 'claimWorklistItemId' ? async (_id: number, itemId: string) => itemId : Reflect.get(target, prop, receiver),
  });
}

export function dryRunRowStore(store: RowStore): RowStore {
  return readOnlyProxy(store, ROW_STORE_MUTATORS);
}

/**
 * The upload route's deps under `off`. Uploads, disbursements and rows are still recorded (seen
 * data, so a re-upload isn't mistaken for new), Monday writes are logged, and every message sent
 * to the queue is stamped `dropped` so the consumer dry-runs it even if the mode is `on` by then.
 */
export function dryRunAppDeps(deps: AppDeps, ctx: SkipContext): AppDeps {
  const stamp = stampFor('off');
  return {
    ...deps,
    mondayClient: dryRunMondayClient(deps.mondayClient, ctx),
    disbursementStore: dryRunDisbursementStore(deps.disbursementStore),
    queue: { sendBatch: (messages) => deps.queue.sendBatch(messages.map((m) => ({ ...m, ...stamp }))) },
  };
}

export function dryRunConsumerDeps(deps: ProcessBatchDeps, ctx: SkipContext): ProcessBatchDeps {
  return {
    ...deps,
    rowStore: dryRunRowStore(deps.rowStore),
    disbursementStore: dryRunDisbursementStore(deps.disbursementStore),
    mondayClient: dryRunMondayClient(deps.mondayClient, ctx),
  };
}
