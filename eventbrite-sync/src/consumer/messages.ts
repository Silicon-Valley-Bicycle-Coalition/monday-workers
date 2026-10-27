import type { WriteQueueMessage } from './processBatch';

// A short name for a queue message, for log lines: `order "1"`, `event "2"`, `attendee "3"`.
export function describeMessage(body: WriteQueueMessage): string {
  if (body.kind === 'event') return `event "${body.eventId}"`;
  if (body.kind === 'attendee') return `attendee "${body.attendeeId}"`;
  return `order "${body.orderId}"`;
}
