import type { MondayClient } from '../monday/client';
import type { LetterSendStore } from '../db/letterSends';
import type { LetterSendQueueMessage } from '../types';
import { listLetterYears } from './loadLetterData';

// Re-exported so importers of this module don't also need to import ../types directly for the
// queue message shape — same convention as ChangeQueueMessage's re-export from submitChangeRequest.ts.
export type { LetterSendQueueMessage };

export type TriggerLetterSendResult =
  | { kind: 'queued' }
  | { kind: 'duplicate' }
  | { kind: 'no-eligible-year' }
  | { kind: 'invalid'; message: string };

export interface TriggerLetterSendDeps {
  monday: MondayClient;
  store: LetterSendStore;
  queue: { send(message: LetterSendQueueMessage): Promise<void> };
  now: () => Date;
}

export async function triggerLetterSend(donorItemId: string, deps: TriggerLetterSendDeps): Promise<TriggerLetterSendResult> {
  if (donorItemId.length === 0) {
    return { kind: 'invalid', message: 'Missing donor item id.' };
  }

  const now = deps.now();
  const [listing] = await listLetterYears([donorItemId], deps.monday, now);
  const year = listing?.years[0];
  if (year === undefined) {
    return { kind: 'no-eligible-year' };
  }

  const existing = await deps.store.findByDonorYear(donorItemId, year);
  if (existing !== null) {
    // A 'queued' match means an earlier trigger's row was written but its queue.send either
    // never ran or threw — re-send it now so the consumer (idempotent on status) gets another
    // chance, instead of leaving the row stranded with no message ever in flight. Same pattern
    // as submitChangeRequest's dedupe-hit handling.
    if (existing.status === 'queued') {
      await deps.queue.send({ sendId: existing.id });
    }
    return { kind: 'duplicate' };
  }

  const id = await deps.store.createQueued({ donorItemId, year, createdAt: now.toISOString() });
  await deps.queue.send({ sendId: id });
  return { kind: 'queued' };
}
