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

// Retry backoff (funraise-sync #25, same numbers): 60 s × 4^(attempt−1) gives 1, 4 and 16 minutes
// across wrangler.jsonc's max_retries of 3 — about 21 minutes of cover for a Monday blip — capped
// at Queues' 12-hour maximum delay.
const RETRY_BASE_SECONDS = 60;
const RETRY_FACTOR = 4;
const MAX_RETRY_DELAY_SECONDS = 12 * 60 * 60;

export function retryDelaySeconds(attempts: number | undefined): number {
  const attempt = typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  return Math.min(RETRY_BASE_SECONDS * RETRY_FACTOR ** (attempt - 1), MAX_RETRY_DELAY_SECONDS);
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
  for (const message of messages) {
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

  if (match.unmatched.length > 0) {
    try {
      await deps.reply.sendUnmatched(
        msg.staffEmail,
        msg.subject,
        `${config.monday.accountUrl}/boards/${board}/pulses/${itemId}`,
        match.unmatched,
        match.personItemIds.length === 0
      );
    } catch (err) {
      // The item is written; a lost reply is not worth a retry that would re-check and adopt it.
      console.error(`email-log consumer: ${shortId(hash)} logged, but the unmatched-address reply failed: ${errorText(err)}`);
    }
  }
}
