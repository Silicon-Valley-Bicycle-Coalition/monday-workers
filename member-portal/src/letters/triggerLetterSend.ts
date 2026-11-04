import type { MondayClient } from '../monday/client';
import type { LetterSendStore } from '../db/letterSends';
import type { LetterSendQueueMessage, TaxLetterConfig } from '../types';
import { listLetterYears } from './loadLetterData';

// Re-exported so importers of this module don't also need to import ../types directly for the
// queue message shape — same convention as ChangeQueueMessage's re-export from submitChangeRequest.ts.
export type { LetterSendQueueMessage };

export type TriggerLetterSendResult =
  // 'queued' covers both a brand-new row and a previously 'skipped' row that got requeued for a
  // fresh attempt — both are real send attempts now in flight, unlike 'duplicate'.
  | { kind: 'queued' }
  | { kind: 'duplicate' }
  | { kind: 'no-eligible-year' }
  | { kind: 'invalid'; message: string };

export interface TriggerLetterSendDeps {
  monday: MondayClient;
  taxLetter: TaxLetterConfig;
  store: LetterSendStore;
  queue: { send(message: LetterSendQueueMessage): Promise<void> };
  now: () => Date;
}

export async function triggerLetterSend(donorItemId: string, deps: TriggerLetterSendDeps): Promise<TriggerLetterSendResult> {
  if (donorItemId.length === 0) {
    return { kind: 'invalid', message: 'Missing donor item id.' };
  }

  const now = deps.now();
  const [listing] = await listLetterYears([donorItemId], deps.monday, deps.taxLetter, now);
  const year = listing?.years[0];
  if (year === undefined) {
    return { kind: 'no-eligible-year' };
  }

  const existing = await deps.store.findByDonorYear(donorItemId, year);
  if (existing !== null) {
    if (existing.status === 'queued') {
      // Stranded: an earlier trigger's row was written but its queue.send either never ran
      // or threw — re-send now so the consumer (idempotent on status) gets another chance,
      // instead of leaving the row stranded with no message ever in flight. Same pattern as
      // submitChangeRequest's dedupe-hit handling.
      await deps.queue.send({ sendId: existing.id });
      return { kind: 'duplicate' };
    }
    if (existing.status === 'skipped') {
      // A prior send attempt was deliberately skipped (config gate not open yet, or the
      // donor's gifts were momentarily missing) — the condition may have resolved since, so
      // requeue and give it a fresh attempt rather than permanently locking this donor+year
      // out (the letter_sends UNIQUE(donor_item_id, year) index means a fresh row can never
      // be created here).
      await deps.store.requeue(existing.id, now.toISOString());
      await deps.queue.send({ sendId: existing.id });
      return { kind: 'queued' };
    }
    // 'sent', or 'sending' (claimed by a consumer that may already have emailed — never resent
    // automatically; see processLetterSendBatch) — a true no-op either way.
    return { kind: 'duplicate' };
  }

  const id = await deps.store.createQueued({ donorItemId, year, createdAt: now.toISOString() });
  await deps.queue.send({ sendId: id });
  return { kind: 'queued' };
}
