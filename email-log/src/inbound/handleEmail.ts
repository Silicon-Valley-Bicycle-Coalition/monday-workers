import PostalMime from 'postal-mime';
import type { LoggedMessageStore } from '../db/loggedMessages';
import type { EmailLogConfig } from '../types';
import { authenticateSender } from './authenticate';
import { messageIdHash } from './dedupe';
import { extract, type LogQueueMessage } from './extract';
import { errorText } from '../logSafe';
import { stampFor, type WriteMode } from '../flags';
import { DROPPED_ERROR } from '../writeSwitch';

export interface HandleEmailDeps {
  config: EmailLogConfig;
  store: LoggedMessageStore;
  queue: Queue<LogQueueMessage>;
  now: () => Date;
  // The write switch's mode, read once per message (src/flags.ts). Stamps the queued message.
  writeMode: () => Promise<WriteMode>;
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

  let mode: WriteMode;
  try {
    mode = await deps.writeMode();
    await deps.queue.send({ ...extracted.message, messageIdHash: hash, staffEmail: auth.staffEmail, ...stampFor(mode) });
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
  if (mode === 'off') {
    // The message is stamped dropped, so it will never be written. Close the row out as failed
    // (claim() re-opens only those) so a staff re-send once the switch is on is logged rather than
    // swallowed as a duplicate. The consumer repeats this when it dry-runs the message, so a
    // failure here is only logged.
    try {
      await deps.store.markFailed(hash, DROPPED_ERROR);
    } catch (err) {
      console.error(`email-log inbound: ${id} could not mark the dropped row: ${errorText(err)}`);
    }
  }
  log('queued', { id, kind });
}
