// Pure helpers for compare-attendee-pairs.mjs: no I/O, so node:test can cover them.

// Eventbrite attendee statuses that mean the ticket no longer counts.
const DEAD = new Set(['Not Attending', 'Deleted', 'Transferred']);

// Reduce an Eventbrite attendee object to the facts worth comparing. Names and emails are left
// out on purpose: the verdict never needs them, and the output lands in a terminal and scrollback.
export function summarizeAttendee(a) {
  if (!a) return null;
  return {
    id: String(a.id),
    orderId: a.order_id == null ? null : String(a.order_id),
    status: a.status ?? null,
    cancelled: Boolean(a.cancelled),
    refunded: Boolean(a.refunded),
    ticketClass: a.ticket_class_name ?? null,
    created: a.created ?? null,
    changed: a.changed ?? null,
  };
}

// What a pair of attendee ids means, given what Eventbrite returned for each (null = not listed).
export function classifyPair(first, second) {
  if (!first || !second) {
    const missing = [!first && 'first', !second && 'second'].filter(Boolean).join(' and ');
    return { verdict: 'MISSING', note: `${missing} attendee not in Eventbrite's list for this event (wrong event id, or deleted)` };
  }
  const sameOrder = first.orderId !== null && first.orderId === second.orderId;
  const firstLive = !first.cancelled && !first.refunded && !DEAD.has(first.status);
  const secondLive = !second.cancelled && !second.refunded && !DEAD.has(second.status);
  if (sameOrder) {
    return { verdict: 'SAME_ORDER', note: 'two tickets on one order: Eventbrite itself holds both attendee records' };
  }
  if (firstLive && secondLive) {
    return { verdict: 'TWO_ORDERS_BOTH_LIVE', note: 'separate orders, both active: a real double registration' };
  }
  if (firstLive !== secondLive) {
    return { verdict: 'TWO_ORDERS_ONE_DEAD', note: 'separate orders, one canceled/refunded: a re-registration, only one counts' };
  }
  return { verdict: 'TWO_ORDERS_BOTH_DEAD', note: 'separate orders, both canceled/refunded' };
}

// Index a list of Eventbrite attendee objects by id.
export function indexAttendees(attendees) {
  const byId = new Map();
  for (const a of attendees) byId.set(String(a.id), a);
  return byId;
}

// The sandbox Volunteers board's far-apart pairs (2026-11-11), with the event id the D1 ledger holds
// for each. Ids only, no personal data.
export const DEFAULT_PAIRS = [
  { label: 'pair 1', event: '1384220283129', attendees: ['22264977783', '22291335293'] },
  { label: 'pair 2', event: '1432234635349', attendees: ['22293995433', '22293995443'] },
  { label: 'pair 3', event: '1384220463669', attendees: ['22488230523', '22488230533'] },
  { label: 'pair 4', event: '1601889838629', attendees: ['22499305503', '22499305513'] },
  { label: 'pair 5', event: '1981270553560', attendees: ['22646102263', '22702632145'] },
  { label: 'pair 6', event: '1981270553560', attendees: ['22650768336', '22699032407'] },
];
