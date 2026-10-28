// member-portal's side of the write switch (src/flags.ts, spec 2026-10-26). The portal is
// donor-facing, so the switch shows up in three places:
//   - routes: the POSTs that write (login request, change requests, card regenerate) render a
//     "temporarily unavailable" page unless the mode is `on`; every GET, the magic-link callback
//     and logout stay live. The letters webhook skips under `off`, runs under `hold` (the queue is
//     paused) and 503s on a KV error.
//   - queue consumers: the dry-run deps below, so processOne runs unchanged and only the last
//     step — the Monday create, the email, or the D1 bookkeeping that records it — is swapped out.
//   - the letter cron: runs only under `on` (it only enqueues, so a dry run shows nothing).
// The retention purges, login_attempts, sessions and card_tokens reads are operational and stay live.
import {
  DEFAULT_PII_KEYS,
  readLogLevel,
  readOnlyProxy,
  readWriteMode,
  recordingProxy,
  stampFor,
  type FlagsBindings,
  type SkipContext,
  type WriteMode,
  type WriteStamp,
} from './flags';
import { environmentOf, type EnvironmentBindings } from './environment';
import type { ProcessChangeBatchDeps } from './changeRequests/processBatch';
import type { ProcessLetterSendBatchDeps } from './letters/processLetterSendBatch';
import type { ChangeRequestStore } from './db/changeRequests';
import type { LetterSendStore } from './db/letterSends';
import type { MagicLinkTokenStore } from './db/tokens';

export const WORKER = 'member-portal';

// Everything a skip line needs except the delivery, which is per message or per request.
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// Change requests carry the donor's old and new address/email/phone as `oldValue`/`newValue`, and
// the letter email's `loginUrl` carries a (dry-run, never stored) magic-link token.
export const MEMBER_PORTAL_PII_KEYS: readonly string[] = [...DEFAULT_PII_KEYS, 'value', 'url', 'token', 'template'];

const MONDAY_SINK = 'Monday';
const EMAIL_SINK = 'Email';

// Read once per request, per queue batch or per cron run.
export async function readGate(env: FlagsBindings & EnvironmentBindings): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: MEMBER_PORTAL_PII_KEYS };
}

// A per-request gate that reads KV at most once, and only if a gated route asks.
export function lazyGate(read: () => Promise<BatchSkipContext>): () => Promise<BatchSkipContext> {
  let pending: Promise<BatchSkipContext> | undefined;
  return () => (pending ??= read());
}

// Every enqueue goes through this, so a message sent under `off` carries the dropped stamp and stays
// a dry run even if the switch is flipped on before it is consumed. (Today the gated routes and
// the cron only enqueue under `on`, and the letters webhook under `on`/`hold`, so the stamp is
// empty; it is there so a later caller can't forget it.)
export function stampedQueue<T extends WriteStamp>(queue: { send(message: T): Promise<void> }, mode: WriteMode): { send(message: T): Promise<void> } {
  return { send: (message) => queue.send({ ...message, ...stampFor(mode) }) };
}

const CHANGE_STORE_MUTATORS = ['createRequest', 'markWritten', 'purgeWrittenBefore'] as const satisfies readonly (keyof ChangeRequestStore)[];

export function dryRunChangeDeps(deps: ProcessChangeBatchDeps, ctx: SkipContext): ProcessChangeBatchDeps {
  return {
    ...deps,
    store: readOnlyProxy(deps.store, CHANGE_STORE_MUTATORS),
    // createChangeRequestItem returns nothing, so there is no placeholder id to mint.
    monday: recordingProxy(deps.monday, MONDAY_SINK, { createChangeRequestItem: undefined }, ctx),
  };
}

const LETTER_STORE_MUTATORS = [
  'createQueued',
  'claimForSending',
  'releaseClaim',
  'markSent',
  'markSkipped',
  'requeue',
] as const satisfies readonly (keyof LetterSendStore)[];

const TOKEN_STORE_MUTATORS = ['createToken', 'consumeToken'] as const satisfies readonly (keyof MagicLinkTokenStore)[];

export function dryRunLetterDeps(deps: ProcessLetterSendBatchDeps, ctx: SkipContext): ProcessLetterSendBatchDeps {
  const readOnly = readOnlyProxy(deps.store, LETTER_STORE_MUTATORS);
  return {
    ...deps,
    // The claim is dropped like every other write, but it must report success so the dry run
    // reaches the email and records it (a dropped claim resolving undefined reads as "a
    // concurrent delivery won").
    store: new Proxy(readOnly, {
      get: (target, prop, receiver) => (prop === 'claimForSending' ? async () => true : Reflect.get(target, prop, receiver)),
    }),
    // No live magic link is minted for an email that is never sent.
    tokenStore: readOnlyProxy(deps.tokenStore, TOKEN_STORE_MUTATORS),
    emailSender: recordingProxy(deps.emailSender, EMAIL_SINK, { sendLetterReadyEmail: undefined, sendLoginEmail: undefined }, ctx),
    monday: recordingProxy(deps.monday, MONDAY_SINK, { createChangeRequestItem: undefined }, ctx),
  };
}
