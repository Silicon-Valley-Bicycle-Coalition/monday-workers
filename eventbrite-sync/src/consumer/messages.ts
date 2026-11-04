import type { WriteQueueMessage } from './processBatch';
import type { WriteStamp } from '../flags';

// A short name for a queue message, for log lines: `order "1"`, `event "2"`, `attendee "3"`.
export function describeMessage(body: WriteQueueMessage): string {
  if (body.kind === 'event') return `event "${body.eventId}"`;
  if (body.kind === 'attendee') return `attendee "${body.attendeeId}"`;
  return `order "${body.orderId}"`;
}

// The skip line's delivery id: `order:1`, `event:2`, `attendee:3`.
export function messageDeliveryId(body: WriteQueueMessage): string {
  if (body.kind === 'event') return `event:${body.eventId}`;
  if (body.kind === 'attendee') return `attendee:${body.attendeeId}`;
  return `order:${body.orderId}`;
}

// A message the consumer sends on behalf of another (an event's attendee fan-out, an attendee's
// request for its event) carries its parent's stamp, so a dropped delivery never spawns live work.
export function stampOf(parent: WriteStamp): WriteStamp {
  return parent.writeStamp === 'dropped' ? { writeStamp: 'dropped' } : {};
}
