import type { EventQueueMessage, ProcessBatchDeps } from './processBatch';

// Task 5 replaces this body: fetch the event, upsert its Events board item, fan out attendees.
export async function processEvent(_message: EventQueueMessage, _deps: ProcessBatchDeps): Promise<void> {
  throw new Error('not implemented');
}
