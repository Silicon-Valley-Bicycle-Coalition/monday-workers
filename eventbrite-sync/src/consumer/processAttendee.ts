import type { AttendeeQueueMessage, ProcessBatchDeps } from './processBatch';

// Task 6 replaces this body: fetch the attendee, upsert its Event Registrations item.
export async function processAttendee(_message: AttendeeQueueMessage, _deps: ProcessBatchDeps): Promise<void> {
  throw new Error('not implemented');
}
