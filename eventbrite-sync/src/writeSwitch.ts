// eventbrite-sync's side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run versions
// of the consumer's deps. The business logic runs unchanged against them, so a dry run fetches,
// maps and matches exactly as a live run would; only the last step — the Monday write or the D1
// bookkeeping that records it — is swapped out here. The Eventbrite client is GET-only and passes
// through untouched.
import { readOnlyProxy, recordingProxy, type SkipContext } from './flags';
import type { OrderStore } from './db/orders';
import type { MondayClient, MondayItem } from './monday/client';
import type { ProcessBatchDeps } from './consumer/processBatch';
import type { MondayBoards } from './types';

// Everything a skip line needs except the delivery, which is per message.
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// Each Monday write is logged under the board it targets, so a skip line says which write in the
// People → Donations chain it was.
const SINK_NAMES: Record<keyof MondayBoards, string> = {
  'donations:live': 'Donations',
  'people-live': 'People',
};

// The ledger writes a dry run must not make: a placeholder item id stored here (matched_donor_item_id
// or monday_item_id) would survive the flip back to `on`, a Donation "already written" or a donor
// "already matched" to an item that doesn't exist. `recordDelivery` is the webhook's, never reached
// through the consumer's deps; it is listed so the proxy is complete.
const ORDER_STORE_MUTATORS = ['recordDelivery', 'updateStatus'] as const;

/**
 * A MondayClient that forwards reads and records each create/update as a skip line under its
 * board's sink name. A create resolves to a placeholder `{ id: 'dry-run-N' }` (N counted per
 * board) so a chained write can still link to it; nothing persists that id (the store below).
 */
export function dryRunMondayClient(client: MondayClient, boards: MondayBoards, ctx: SkipContext): MondayClient {
  const proxies = new Map<string, MondayClient>();
  const sinkFor = (boardId: number): MondayClient => {
    const key = (Object.keys(SINK_NAMES) as (keyof MondayBoards)[]).find((k) => boards[k] === boardId);
    const sink = key ? SINK_NAMES[key] : `Monday board ${boardId}`;
    let proxy = proxies.get(sink);
    if (!proxy) {
      proxy = recordingProxy(client, sink, {
        createItem: function (): MondayItem {
          return { id: `dry-run-${this.n}` };
        },
        changeColumnValues: undefined,
      }, ctx);
      proxies.set(sink, proxy);
    }
    return proxy;
  };
  return {
    findItemByColumnValue: (boardId, columnId, value) => client.findItemByColumnValue(boardId, columnId, value),
    createItem: (boardId, itemName, columnValues) => sinkFor(boardId).createItem(boardId, itemName, columnValues),
    changeColumnValues: (boardId, itemId, columnValues) => sinkFor(boardId).changeColumnValues(boardId, itemId, columnValues),
  };
}

export function dryRunOrderStore(store: OrderStore): OrderStore {
  return readOnlyProxy(store, ORDER_STORE_MUTATORS);
}

export function dryRunConsumerDeps(deps: ProcessBatchDeps, ctx: SkipContext): ProcessBatchDeps {
  return {
    ...deps,
    orderStore: dryRunOrderStore(deps.orderStore),
    mondayClient: dryRunMondayClient(deps.mondayClient, deps.config.monday.boards, ctx),
  };
}
