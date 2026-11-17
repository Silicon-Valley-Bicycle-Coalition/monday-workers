// mailchimp-sync's side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run versions
// of the consumers' and the reconcile cron's deps. The business logic runs unchanged against them,
// so a dry run reads Monday and Mailchimp and builds every mutation exactly as a live run would;
// only the last step — the Mailchimp or Monday write, or the D1 bookkeeping that records it — is
// swapped out here. The dead-letter consumers and their Slack alert are not gated (DLQs stay live).
import { readOnlyProxy, recordingProxy, type SkipContext } from './flags';
import type { MailchimpClient, ManagedTags, RenameMemberResult, UnsubscribeResult } from './mailchimp/client';
import type { MondayClient } from './monday/client';
import type { CampaignItemRow, CampaignItemsStore } from './db/campaignItems';
import type { DnsUnsubscribeLog } from './db/dnsUnsubscribes';
import type { PendingOutboundStore } from './db/pendingOutbound';
import type { PendingInboundStore } from './db/pendingInbound';
import type { OutboundConsumerDeps } from './consumer/outbound';
import type { InboundConsumerDeps } from './consumer/inbound';
import type { ReconcileDeps } from './campaigns/reconcile';
import type { PendingStatus } from './types';
import type { ConsentMonday } from './consent/sources';

// Everything a skip line needs except the delivery, which is per message (or per cron run).
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

const MAILCHIMP_SINK = 'Mailchimp';
const MONDAY_SINK = 'Monday';

function dryRunMailchimp(client: MailchimpClient, ctx: SkipContext): MailchimpClient {
  const recording = recordingProxy(client, MAILCHIMP_SINK, {
    updateMember: () => 'updated',
    renameMember: (): RenameMemberResult => 'renamed',
    unsubscribeMember: (): UnsubscribeResult => 'unsubscribed',
  }, ctx);
  // updateMember's managed tags can be a reader the live client calls after its PATCH (#97). The
  // placeholder never PATCHes, so resolve it here: the skip line then names the tags the write
  // would have deactivated, as it did when the consumer read them up front.
  return new Proxy(recording, {
    get: (target, prop, receiver) =>
      prop === 'updateMember'
        ? async (email: string, mergeFields: Record<string, unknown>, tags: string[], managed: ManagedTags) =>
            recording.updateMember(email, mergeFields, tags, typeof managed === 'function' ? await managed() : managed)
        : Reflect.get(target, prop, receiver),
  });
}

function dryRunMonday(client: MondayClient, ctx: SkipContext): MondayClient {
  return recordingProxy(client, MONDAY_SINK, {
    // A placeholder id, so reconcile can carry on to the connect-column write. It is never stored:
    // dryRunCampaignItemsStore keeps it in memory for this run only.
    createCampaignItem: function () {
      return `dry-run-${this.n}`;
    },
    renameItem: undefined,
    archiveItem: undefined,
    setConnectColumn: undefined,
  }, ctx);
}

// A pending store for a dry run: every write dropped except updateStatus(key, 'dropped'), which
// reaches the real store. The consumer makes that one call per message it dry-runs, so a delivery
// ingested live but consumed under `off` is closed out as dropped rather than left looking like
// work in flight.
function dryRunPending<T extends PendingOutboundStore | PendingInboundStore>(store: T): T {
  const readOnly = readOnlyProxy(store, ['upsertPending', 'updateStatus', 'recordSyncStart'] as (keyof T)[]);
  return new Proxy(readOnly, {
    get: (target, prop, receiver) =>
      prop === 'updateStatus'
        ? async (key: string, status: PendingStatus) => {
            if (status === 'dropped') await store.updateStatus(key, status);
          }
        : Reflect.get(target, prop, receiver),
  });
}

/**
 * The campaign catalog with every write dropped. The dropped `claim` reports the claim as won
 * (dropped to undefined it would read as lost, and reconcile would skip the create — and the skip
 * line with it). An in-memory overlay of this run's upserts lets an inbound dry run that
 * reconciles a brand-new interest resolve it afterward, instead of failing "could not be
 * resolved" and retrying a message that is only being rehearsed. The overlay dies with the run.
 */
export function dryRunCampaignItemsStore(store: CampaignItemsStore): CampaignItemsStore {
  const overlay = new Map<string, CampaignItemRow>();
  const readOnly = readOnlyProxy(store, ['upsert', 'markArchived', 'claim']);
  return new Proxy(readOnly, {
    get: (target, prop, receiver) => {
      if (prop === 'claim') return async () => true;
      if (prop === 'upsert') return async (row: CampaignItemRow) => void overlay.set(row.interestId, row);
      if (prop === 'getByInterestIds') {
        return async (interestIds: readonly string[]) => {
          const rows = await store.getByInterestIds(interestIds.filter((id) => !overlay.has(id)));
          for (const id of interestIds) {
            const row = overlay.get(id);
            if (row !== undefined) rows.set(id, row);
          }
          return rows;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function dryRunOutboundDeps(deps: OutboundConsumerDeps, ctx: SkipContext): OutboundConsumerDeps {
  return {
    ...deps,
    pendingStore: dryRunPending(deps.pendingStore),
    mailchimpClient: dryRunMailchimp(deps.mailchimpClient, ctx),
    dnsLog: readOnlyProxy<DnsUnsubscribeLog>(deps.dnsLog, ['record']),
  };
}

export function dryRunInboundDeps(deps: InboundConsumerDeps, ctx: SkipContext): InboundConsumerDeps {
  return {
    ...deps,
    pendingStore: dryRunPending(deps.pendingStore),
    mondayClient: dryRunMonday(deps.mondayClient, ctx),
    campaignItemsStore: dryRunCampaignItemsStore(deps.campaignItemsStore),
  };
}

// The reconcile cron's deps for a run that runDisposition allowed: live for `run`, proxied for
// `dry-run`. The inline reconcile inside an inbound message uses its caller's deps, so it takes
// the caller's disposition.
export function reconcileDepsFor(disposition: 'run' | 'dry-run', deps: ReconcileDeps, ctx: SkipContext): ReconcileDeps {
  if (disposition === 'run') return deps;
  return {
    ...deps,
    mondayClient: dryRunMonday(deps.mondayClient, ctx),
    campaignItemsStore: dryRunCampaignItemsStore(deps.campaignItemsStore),
  };
}

// The hourly consent run's Monday writes under `off`: one skip line per writeConsent call (its
// argument is item ids and labels, never an address), and nothing written.
export function dryRunConsentMonday(monday: ConsentMonday, ctx: SkipContext): ConsentMonday {
  return recordingProxy(monday, MONDAY_SINK, {
    writeConsent: () => ({ written: 0, failedItemIds: [] }),
  }, ctx);
}
