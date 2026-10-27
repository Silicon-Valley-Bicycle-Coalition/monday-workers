import { raiseAlert } from '../alerts/itRequests';
import { PLACEHOLDER_COLUMN_ID } from '../config';
import type { LoggedMessageStore } from '../db/loggedMessages';
import type { ReplySender } from '../email/reply';
import type { LogQueueMessage } from '../inbound/extract';
import { errorText } from '../logSafe';
import { buildActivity } from '../mapping/activity';
import { matchAddresses } from '../matching/people';
import type { MondayClient } from '../monday/client';
import type { EmailLogConfig } from '../types';
import { logDebug, messageDisposition, retryDelaySeconds } from '../flags';
import { DROPPED_ERROR, dryRunDeps, type BatchSkipContext } from '../writeSwitch';

// Copied from eventbrite-sync/src/consumer/processBatch.ts.
export interface QueueMessageLike<T> {
  body: T;
  // Cloudflare's Message.attempts (1 on first delivery) and Message.timestamp (when it was
  // sent). Optional so tests and callers that don't care can omit them.
  attempts?: number;
  timestamp?: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumerDeps {
  config: EmailLogConfig;
  store: LoggedMessageStore;
  monday: MondayClient;
  reply: ReplySender;
  now: () => Date;
}

const ACTIVITY_COLUMN_KEYS = ['activityTypeColumn', 'dateColumn', 'statusColumn', 'ownerColumn', 'personColumn', 'notesColumn', 'messageHashColumn'] as const;

const BOARD_FULL = 'Board has reached its max size';

// The correlation id in every log line: never an address, subject or body.
export const shortId = (hash: string): string => hash.slice(0, 12);

/** Throws, naming the config key, while the Activities (Logged) board or a column is unconfigured. */
function activitiesBoard(config: EmailLogConfig): number {
  const board = config.monday.boards['activities-logged'];
  if (board === null) throw new Error('config: monday.boards.activities-logged is not configured');
  for (const key of ACTIVITY_COLUMN_KEYS) {
    if (config.activities[key] === PLACEHOLDER_COLUMN_ID) throw new Error(`config: activities.${key} is not configured`);
  }
  return board;
}

// Messages run one at a time: Monday's complexity budget is per-minute, and wrangler.jsonc's
// max_concurrency of 1 already serializes batches.
export async function processLogBatch(messages: QueueMessageLike<LogQueueMessage>[], deps: ConsumerDeps): Promise<void> {
  for (const message of messages) await handleMessage(message, deps);
}

// The queue entry point for the write queue (index.ts): the write switch's mode, read once for the
// batch, decides per message whether it writes (`on`, unstamped), dry-runs against recording
// proxies (`off`, or stamped dropped by the inbound handler), or waits on the queue (`hold`,
// `unknown`).
export async function consumeLogBatch(messages: QueueMessageLike<LogQueueMessage>[], deps: ConsumerDeps, gate: BatchSkipContext): Promise<void> {
  for (const message of messages) {
    const disposition = messageDisposition(gate.mode, message.body);
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    } else if (disposition === 'write') {
      await handleMessage(message, deps);
    } else {
      const hash = message.body.messageIdHash;
      const ctx = { ...gate, deliveryId: shortId(hash) };
      // The one ledger write a dry run makes: close the row out as failed (dropped) so a staff
      // re-send after the switch is on is claimed and logged, not swallowed as a duplicate. A
      // 'logged' row is never downgraded (markFailed's own guard).
      try {
        await deps.store.markFailed(hash, DROPPED_ERROR);
      } catch (err) {
        // A D1 failure must not escape the batch (every unacked message would redeliver at once):
        // back this one off like any other failure and rehearse it next time.
        console.error(`email-log consumer: ${shortId(hash)} could not record the dropped status: ${errorText(err)}`);
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        continue;
      }
      logDebug(ctx, 'message', message.body);
      await handleMessage(message, dryRunDeps(deps, ctx));
    }
  }
}

async function handleMessage(message: QueueMessageLike<LogQueueMessage>, deps: ConsumerDeps): Promise<void> {
  const hash = message.body.messageIdHash;
  try {
    await processOne(message.body, deps);
    message.ack();
  } catch (err) {
    const error = errorText(err);
    console.error(`email-log consumer: ${shortId(hash)} failed (attempt ${message.attempts ?? 1}): ${error}`);
    // Bookkeeping only: a D1 error here must not take the retry decision down with it. Never
    // markFailed here: the message is still live in the queue, and a 'failed' row would let a
    // redelivered inbound copy claim and enqueue a second one. Only the DLQ sets 'failed'.
    try {
      await deps.store.recordError(hash, error);
    } catch (recordErr) {
      console.error(`email-log consumer: ${shortId(hash)} could not record the failure: ${errorText(recordErr)}`);
    }
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

async function processOne(msg: LogQueueMessage, deps: ConsumerDeps): Promise<void> {
  const { config, store, monday } = deps;
  const hash = msg.messageIdHash;
  const board = activitiesBoard(config);

  // A retry after an ambiguous create (timeout, 5xx) may find its item already there: adopt it
  // rather than create a second one. No re-match and no reply: the first attempt's outcome stands.
  const existing = await monday.findItemIdsByColumnValue(board, config.activities.messageHashColumn, hash);
  if (existing[0] !== undefined) {
    await store.markLogged(hash, existing[0], deps.now().toISOString());
    console.log(JSON.stringify({ emailLog: 'adopted', id: shortId(hash) }));
    return;
  }

  const count = await monday.boardItemsCount(board);
  const max = config.capacity.activitiesMaxItems;
  if (count >= (max * config.capacity.warnPct) / 100) {
    await raiseAlert('capacity', `email-log: Activities (Logged) board ${board} holds ${count} of ${max} items`, deps);
  }

  const match = await matchAddresses(msg.counterparts, monday, config);
  const ownerUserId = await monday.findUserIdByEmail(msg.staffEmail);
  const { name, columnValues } = buildActivity(msg, match, ownerUserId, config);

  let itemId: string;
  try {
    itemId = await monday.createItem(board, name, columnValues);
  } catch (err) {
    if (err instanceof Error && err.message.includes(BOARD_FULL)) {
      await raiseAlert('board-full', `email-log: Activities (Logged) board ${board} is full`, deps);
    }
    throw err;
  }
  await store.markLogged(hash, itemId, deps.now().toISOString());
  console.log(JSON.stringify({ emailLog: 'logged', id: shortId(hash), unmatched: match.unmatched.length }));

  // Anything left Needs Person, or with an address not on file, gets a reply saying what to fix.
  if (match.personItemIds.length === 0 || match.unmatched.length > 0) {
    const itemUrl = `${config.monday.accountUrl}/boards/${board}/pulses/${itemId}`;
    try {
      if (msg.counterparts.length === 0) await deps.reply.sendNoAddress(msg.staffEmail, msg.subject, itemUrl);
      else await deps.reply.sendUnmatched(msg.staffEmail, msg.subject, itemUrl, match.unmatched, match.personItemIds.length === 0);
    } catch (err) {
      // The item is written; a lost reply is not worth a retry that would re-check and adopt it.
      console.error(`email-log consumer: ${shortId(hash)} logged, but the reply to staff failed: ${errorText(err)}`);
    }
  }
}
