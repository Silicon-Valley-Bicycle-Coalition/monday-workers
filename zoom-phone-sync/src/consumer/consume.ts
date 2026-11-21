// The queue consumer (#54, design "Flow" step 4 and "What lands in Monday"): match the event's
// number in the phone index, write one timeline entry per matching People item, advance Last
// Phone Contact, and mark the row logged. Log lines carry event ids and counts only, never a
// number, a name or an item id.
import type { LogStore, PhoneQueueMessage, StoredEvent } from '../db/events';
import { messageDisposition, retryDelaySeconds, type WriteMode } from '../flags';
import type { PhoneLogMondayClient } from '../monday/client';
import { OutageBreaker } from '../monday/outage';
import type { ZoomPhoneSyncConfig } from '../types';
import { entryFor, isAnswered, pacificDate } from './entry';

export interface QueueMessageLike<T> {
  body: T;
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumerDeps {
  store: LogStore;
  monday: PhoneLogMondayClient;
  config: ZoomPhoneSyncConfig;
  now?: () => number;
}

export type Outcome = 'logged' | 'unmatched' | 'dropped' | 'skipped';

function log(message: string): void {
  console.log(`zoom-phone-sync consumer: ${message}`);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Config the write needs. Thrown, not acked: the message retries until the config is fixed or it
// dead-letters, so nothing is lost to a missing id.
function writeConfig(config: ZoomPhoneSyncConfig, kind: 'call' | 'text') {
  const activity = kind === 'call' ? config.timeline.callActivityId : config.timeline.textActivityId;
  if (activity === null) throw new Error(`config: timeline.${kind}ActivityId is not set`);
  const column = config.people.lastPhoneContactColumn;
  if (column === null) throw new Error('config: people.lastPhoneContactColumn is not set');
  return { activity, column };
}

/** One event, in write mode. Exported for tests. */
export async function logEvent(event: StoredEvent, deps: ConsumerDeps): Promise<Outcome> {
  // A row already logged or dropped is a redelivery: nothing left to do. Rows `pending`,
  // `unmatched` (a rematch whose status update was lost) and `failed` (a redrive) are all worked.
  if (event.status === 'logged' || event.status === 'dropped') return 'skipped';
  const now = deps.now ?? Date.now;

  if (event.externalE164 === null) {
    // Only logged and dropped rows clear the number; anything else without one can't be matched.
    log(`${event.eventId}: no number on the row; marked unmatched`);
    await deps.store.markUnmatched(event.eventId);
    return 'unmatched';
  }

  const matched = await deps.store.matchItems(event.externalE164);
  if (matched.length === 0) {
    await deps.store.markUnmatched(event.eventId);
    return 'unmatched';
  }

  const { activity, column } = writeConfig(deps.config, event.kind);
  const done = await deps.store.loggedItems(event.eventId);
  const todo = matched.filter((id) => !done.has(id));
  // The index is a night old: an item deleted since is skipped rather than failing the event.
  const names = await deps.monday.itemNames(todo);
  const advance = isAnswered(event);
  const date = pacificDate(event.occurredAt);

  let written = 0;
  for (const itemId of todo) {
    const name = names.get(itemId);
    if (name === undefined) continue;
    // The date first: it's idempotent, so a retry after a failed create just keeps it.
    if (advance) await deps.monday.advanceDate(deps.config.people.boardId, itemId, column, date);
    const timelineId = await deps.monday.createTimelineItem({
      itemId,
      customActivityId: activity,
      timestamp: event.occurredAt,
      ...entryFor(event, name, deps.config.zoom.smsUrl),
    });
    await deps.store.recordItem(event.eventId, itemId, timelineId);
    written += 1;
  }

  // Every matching item is gone and none was logged before: wait for tonight's index instead.
  if (written === 0 && done.size === 0) {
    await deps.store.markUnmatched(event.eventId);
    return 'unmatched';
  }

  await deps.store.markLogged(event.eventId, new Date(now()).toISOString());
  return 'logged';
}

/**
 * The queue() entry point for the write queue. Per message: the write switch decides first
 * (`retry` under hold/unknown leaves it queued, `dry-run` under off or a `dropped` stamp marks the
 * row dropped without touching Monday); then the outage breaker; then the write.
 */
export async function consumeBatch(
  messages: QueueMessageLike<PhoneQueueMessage>[],
  mode: WriteMode,
  deps: ConsumerDeps,
): Promise<Record<Outcome | 'retried' | 'missing', number>> {
  const counts = { logged: 0, unmatched: 0, dropped: 0, skipped: 0, retried: 0, missing: 0 };
  const breaker = new OutageBreaker();

  for (const message of messages) {
    const { eventId } = message.body;
    const disposition = messageDisposition(mode, message.body);
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      counts.retried += 1;
      continue;
    }
    if (breaker.open) {
      breaker.defer(message);
      counts.retried += 1;
      continue;
    }

    try {
      const event = await deps.store.getEvent(eventId);
      if (event === null) {
        log(`${eventId}: no phone_events row; acked`);
        counts.missing += 1;
        message.ack();
        continue;
      }
      if (disposition === 'dry-run') {
        if (event.status !== 'logged') await deps.store.markDropped(eventId);
        counts.dropped += 1;
        message.ack();
        continue;
      }
      counts[await logEvent(event, deps)] += 1;
      message.ack();
    } catch (err) {
      const outage = breaker.trip(err);
      log(`${eventId}: failed: ${errorText(err)}${outage ? ' — Monday unavailable, deferring the rest of the batch' : ''}`);
      // Bookkeeping only: a D1 error here must not stop the retry below.
      await deps.store.recordAttempt(eventId).catch(() => undefined);
      if (outage) breaker.defer(message);
      else message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      counts.retried += 1;
    }
  }
  return counts;
}

/**
 * The dead-letter queue: a message that exhausted its retries marks its row `failed` (unless it
 * was logged since) and the batch logs one line naming the event ids. Nothing is re-driven here.
 */
export async function processDeadLetters(messages: QueueMessageLike<PhoneQueueMessage>[], store: LogStore): Promise<void> {
  const dead: string[] = [];
  for (const message of messages) {
    try {
      await store.markFailed(message.body.eventId);
      dead.push(message.body.eventId);
      message.ack();
    } catch (err) {
      log(`dlq: could not mark ${message.body.eventId} failed: ${errorText(err)}`);
      message.retry();
    }
  }
  if (dead.length > 0) console.error(`zoom-phone-sync dlq: ${dead.length} event(s) not logged after every retry: ${dead.join(', ')}`);
}
