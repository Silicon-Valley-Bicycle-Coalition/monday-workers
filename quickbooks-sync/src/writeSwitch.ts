// quickbooks-sync's side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run version
// of the consumer's deps. The business logic runs unchanged against them, so a dry run validates,
// maps and builds every mutation exactly as a live run would; only the last step — the Monday or
// QuickBooks write, or the D1 bookkeeping that records it — is swapped out here.
import { readOnlyProxy, recordingProxy, type SkipContext } from './flags';
import type { ConsumerDeps } from './consumer/processBatch';
import type { MondayClient, MondayItem } from './monday/client';
import type { QuickBooksClient } from './quickbooks/client';

// Everything a skip line needs except the delivery, which is per message.
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// The ledger writes a dry run must not make. A placeholder id stored here would survive the flip
// back to `on`: a Monday item "already created" or a Customer "already created" that doesn't
// exist. markCreateSent is the one that runs BEFORE the QuickBooks POST (processBatch.ts), and
// counting a send that never happened would stop a later rejection from advancing the requestid.
// D1TokenStore is deliberately not here: getEntity refreshes the OAuth token, which is
// operational and must stay live.
const QB_EVENT_STORE_MUTATORS = ['updateStatus'] as const;
const MONDAY_EVENT_STORE_MUTATORS = ['updateStatus', 'markCreateSent'] as const;
const MAP_STORE_MUTATORS = ['createMapping', 'repointMapping'] as const;

/**
 * The consumer's deps with every sink recorded and every ledger write dropped. Creates resolve to
 * placeholders (`dry-run-N`) so a chained write can still run; nothing persists them (the stores
 * below). Reads, including QuickBooks' getEntity, pass through to the real clients.
 */
export function dryRunConsumerDeps(deps: ConsumerDeps, ctx: SkipContext): ConsumerDeps {
  return {
    ...deps,
    qbEventStore: readOnlyProxy(deps.qbEventStore, QB_EVENT_STORE_MUTATORS),
    mondayEventStore: readOnlyProxy(deps.mondayEventStore, MONDAY_EVENT_STORE_MUTATORS),
    mapStore: readOnlyProxy(deps.mapStore, MAP_STORE_MUTATORS),
    mondayClient: recordingProxy<MondayClient>(deps.mondayClient, 'Monday', {
      createItem: function (): MondayItem {
        return { id: `dry-run-${this.n}` };
      },
      changeColumnValues: undefined,
    }, ctx),
    quickBooksClient: recordingProxy<QuickBooksClient>(deps.quickBooksClient, 'QuickBooks', {
      createCustomer: function (): { id: string } {
        return { id: `dry-run-${this.n}` };
      },
    }, ctx),
  };
}
