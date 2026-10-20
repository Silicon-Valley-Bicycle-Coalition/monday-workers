import PostalMime from 'postal-mime';
import type { LoggedMessageStore } from '../db/loggedMessages';
import type { EmailLogConfig } from '../types';
import { authenticateSender } from './authenticate';
import { messageIdHash } from './dedupe';
import { extract, type LogQueueMessage } from './extract';
import { errorText } from '../logSafe';

export interface HandleEmailDeps {
  config: EmailLogConfig;
  store: LoggedMessageStore;
  queue: Queue<LogQueueMessage>;
  now: () => Date;
}

// One structured line per message. Never an address, subject or body: only the outcome, a reason
// and the first 12 hex chars of the dedupe hash as a correlation id.
function log(outcome: 'rejected' | 'staff-only' | 'duplicate' | 'queued', fields: Record<string, string> = {}): void {
  console.log(JSON.stringify({ emailLog: outcome, ...fields }));
}

export async function handleEmail(message: ForwardableEmailMessage, deps: HandleEmailDeps): Promise<void> {
  const { mail } = deps.config;

  if (message.rawSize > mail.maxRawBytes) {
    message.setReject('Too large to log. Forward it without attachments.');
    log('rejected', { reason: 'too-large' });
    return;
  }

  let parsed;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch {
    message.setReject('Could not read this message.');
    log('rejected', { reason: 'unparseable' });
    return;
  }

  const auth = authenticateSender(parsed.headers, parsed.from?.address ?? '', mail);
  if (!auth.ok) {
    message.setReject('Only SVBC staff can log to this address.');
    log('rejected', { reason: auth.reason });
    return;
  }

  const extracted = extract(parsed, mail, deps.now());
  if (extracted.kind === 'staff-only') {
    log('staff-only');
    return;
  }

  const hash = await messageIdHash(extracted.dedupeSource);
  const id = hash.slice(0, 12);
  const kind = extracted.message.kind;

  if (!(await deps.store.claim(hash, kind, deps.now().toISOString()))) {
    log('duplicate', { id, kind });
    return;
  }

  try {
    await deps.queue.send({ ...extracted.message, messageIdHash: hash, staffEmail: auth.staffEmail });
  } catch (err) {
    // Rethrowing makes Email Routing answer with a temporary failure, so the sender's server retries.
    // A D1 error here must not replace the queue error: the row then stays 'queued' and a retry
    // is a duplicate, but the cause that surfaces is still the real one.
    try {
      await deps.store.markFailed(hash, errorText(err));
    } catch (markErr) {
      console.error(`email-log inbound: ${id} could not mark the row failed: ${errorText(markErr)}`);
    }
    throw err;
  }
  log('queued', { id, kind });
}
