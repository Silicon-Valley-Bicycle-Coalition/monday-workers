import { raiseAlert } from '../alerts/itRequests';
import type { LogQueueMessage } from '../inbound/extract';
import { errorText } from '../logSafe';
import { shortId, type ConsumerDeps, type QueueMessageLike } from './processBatch';

export const DEAD_LETTER_ERROR = 'dead-lettered after retries';

// Consumer for email-log-writes-dlq. Every step is best-effort and the message is always acked:
// the queue payload is the only copy of the address list and subject outside Monday, so there is
// nothing to re-drive from here. The staff member is told to try again, and IT gets an alert.
export async function processDeadLetters(messages: QueueMessageLike<LogQueueMessage>[], deps: ConsumerDeps): Promise<void> {
  const ids: string[] = [];
  for (const message of messages) {
    const { messageIdHash: hash, staffEmail, subject } = message.body;
    const id = shortId(hash);
    ids.push(id);
    try {
      await deps.store.markFailed(hash, DEAD_LETTER_ERROR);
    } catch (err) {
      console.error(`email-log dlq: ${id} could not record the dead letter: ${errorText(err)}`);
    }
    try {
      await deps.reply.sendNotLogged(staffEmail, subject);
    } catch (err) {
      console.error(`email-log dlq: ${id} could not tell the staff member: ${errorText(err)}`);
    }
    await raiseAlert('dead-letter', `email-log: a message (${id}) could not be logged after retries`, deps);
    message.ack();
  }
  if (ids.length > 0) {
    console.error(
      `email-log: ${ids.length} message${ids.length === 1 ? '' : 's'} dead-lettered after exhausting retries — ${ids.join(', ')}. ` +
        'Not on the Activities (Logged) board; each staff member was asked to try again. The earlier consumer lines for each id carry the cause.'
    );
  }
}
