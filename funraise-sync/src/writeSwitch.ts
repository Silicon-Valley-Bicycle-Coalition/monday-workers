// funraise-sync's side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run versions
// of the consumer's and the poller's deps. The business logic runs unchanged against them, so a
// dry run validates, matches and builds every mutation exactly as a live run would; only the last
// step — the Monday write or the D1 bookkeeping that records it — is swapped out here.
import { readOnlyProxy, recordingProxy, type SkipContext } from './flags';
import type { EventStore } from './db/events';
import type { SubscriptionStore } from './db/subscriptions';
import type { MondayClient, MondayItem } from './monday/client';
import type { ProcessBatchDeps } from './consumer/processBatch';
import type { PollSubscriptionsDeps } from './subscriptions/poll';
import type { MondayBoards } from './types';

// Everything a skip line needs except the delivery, which is per message (or per cron run).
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// Each Monday write is logged under the board it targets, so a skip line says which write in a
// chain (People → Donations, People → Recurring Gifts) it was.
const SINK_NAMES: Record<keyof MondayBoards, string> = {
  'donations:live': 'Donations',
  'recurring-gifts': 'Recurring Gifts',
  'people-live': 'People',
};

// The ledger writes a dry run must not make: a placeholder item id stored here would survive the
// flip back to `on` (a Donation "already written", a donor "already matched" to an item that
// doesn't exist). The purge methods are a separate cron, never reached through these deps.
const EVENT_STORE_MUTATORS = ['upsertEvent', 'updateStatusByEntity', 'purgeWrittenPayloads', 'purgeUnresolvedPayloads'] as const;
const SUBSCRIPTION_STORE_MUTATORS = ['upsert', 'setCursor', 'claimCreate', 'releaseCreate'] as const;

/**
 * A MondayClient that forwards reads and records each create/update as a skip line under its
 * board's sink name. A create resolves to a placeholder `{ id: 'dry-run-N' }` (N counted per
 * board) so a chained write can still link to it; nothing persists that id (the stores below).
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

export function dryRunEventStore(store: EventStore): EventStore {
  return readOnlyProxy(store, EVENT_STORE_MUTATORS);
}

/**
 * The subscriptions ledger with every write dropped, except `setCursor` when `advanceCursor` is
 * set: the poller's cursor moves under `off` (spec 2026-10-26 — a deliberate exception to
 * "advance only after a confirmed write"), so turning writes back on doesn't replay every row
 * the dry run already logged.
 *
 * The dropped `claimCreate` reports the claim as won. Dropped to undefined it would read as
 * lost, and upsertSubscription would throw before reaching its Monday write — which the
 * consumer's resolveRecurringGiftItem swallows, so the Recurring Gifts create would vanish from
 * the dry run instead of logging a skip line.
 */
export function dryRunSubscriptionStore(store: SubscriptionStore, { advanceCursor }: { advanceCursor: boolean }): SubscriptionStore {
  const dropped = SUBSCRIPTION_STORE_MUTATORS.filter((m) => !(advanceCursor && m === 'setCursor'));
  const readOnly = readOnlyProxy(store, dropped);
  return new Proxy(readOnly, {
    get: (target, prop, receiver) => (prop === 'claimCreate' ? async () => true : Reflect.get(target, prop, receiver)),
  });
}

export function dryRunConsumerDeps(deps: ProcessBatchDeps, ctx: SkipContext): ProcessBatchDeps {
  return {
    ...deps,
    eventStore: dryRunEventStore(deps.eventStore),
    mondayClient: dryRunMondayClient(deps.mondayClient, deps.config.monday.boards, ctx),
    subscriptionStore: deps.subscriptionStore && dryRunSubscriptionStore(deps.subscriptionStore, { advanceCursor: false }),
  };
}

// The poller's deps for a cron run that runDisposition allowed: live for `run`, proxied for `dry-run`.
export function pollDepsFor(disposition: 'run' | 'dry-run', deps: PollSubscriptionsDeps, ctx: SkipContext): PollSubscriptionsDeps {
  if (disposition === 'run') return deps;
  return {
    ...deps,
    subscriptionStore: dryRunSubscriptionStore(deps.subscriptionStore, { advanceCursor: true }),
    mondayClient: dryRunMondayClient(deps.mondayClient, deps.config.monday.boards, ctx),
  };
}
