// email-log's side of the write switch (src/flags.ts, spec 2026-10-26): the dry-run version of the
// consumer's deps. processOne runs unchanged against them, so a dry run reads Monday, matches
// People and builds the Activity item and every reply exactly as a live run would; only the last
// step — the Monday create, the staff reply, or the D1 bookkeeping that records it — is swapped
// out here. The dead-letter consumer is not gated (DLQs stay live), and neither is setReject.
import { DEFAULT_PII_KEYS, readOnlyProxy, recordingProxy, type SkipContext } from './flags';
import type { ConsumerDeps } from './consumer/processBatch';
import type { LoggedMessageStore } from './db/loggedMessages';

// Everything a skip line needs except the delivery, which is per message.
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// Subject is free text a staff member typed, so it is masked like a name.
export const EMAIL_LOG_PII_KEYS: readonly string[] = [...DEFAULT_PII_KEYS, 'subject'];

// The error text on a row closed out because the switch was off. claim() re-opens a 'failed' row,
// so a staff re-send once the switch is on is logged instead of being swallowed as a duplicate.
export const DROPPED_ERROR = 'dropped: write switch off';

const MONDAY_SINK = 'Monday';
const EMAIL_SINK = 'Email';

// The ledger with every write dropped (the one close-out the consumer and the inbound handler make
// themselves goes straight to the real store, via markFailed(hash, DROPPED_ERROR)).
const STORE_MUTATORS = ['markLogged', 'markFailed', 'recordError', 'recordAlert'] as const satisfies readonly (keyof LoggedMessageStore)[];

export function dryRunDeps(deps: ConsumerDeps, ctx: SkipContext): ConsumerDeps {
  return {
    ...deps,
    store: readOnlyProxy(deps.store, STORE_MUTATORS),
    // Covers the Activity item and the IT Requests alert. The placeholder is only ever used to
    // build the item URL in the (also recorded) reply, and is stored nowhere.
    monday: recordingProxy(deps.monday, MONDAY_SINK, {
      createItem: function () {
        return `dry-run-${this.n}`;
      },
    }, ctx),
    reply: recordingProxy(deps.reply, EMAIL_SINK, {
      sendUnmatched: undefined,
      sendNoAddress: undefined,
      sendNotLogged: undefined,
    }, ctx),
  };
}
