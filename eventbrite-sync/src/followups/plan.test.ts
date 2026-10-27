import { describe, expect, it } from 'vitest';
import type { EventRow } from '../types';
import { isDue, planFollowups, type Registration } from './plan';

const cfg = { maxAgeDays: 3, sendHourLocal: 8 };

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: 'ev1',
    mondayItemId: '9001',
    startsAt: '2026-10-24T23:00:00.000Z',
    endsAt: '2026-10-25T02:00:00.000Z',
    locationKey: null,
    eventbriteStatus: 'completed',
    status: 'written',
    lastAction: 'event.updated',
    error: null,
    deliveries: 1,
    receivedAt: '2026-10-01T00:00:00.000Z',
    writtenAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isDue', () => {
  it('is due from 08:00 Pacific the day after the class ends (PDT)', () => {
    // Ends Sat 10-24 19:00 PDT; due Sun 10-25 08:00 PDT = 15:00Z.
    const row = event({ endsAt: '2026-10-25T02:00:00.000Z' });
    expect(isDue(row, new Date('2026-10-25T15:00:00Z'), cfg)).toBe(true);
    expect(isDue(row, new Date('2026-10-25T14:59:59Z'), cfg)).toBe(false);
  });

  it('uses the Pacific calendar day across the DST change (08:00 PST the morning after)', () => {
    // Ends Sat 10-31 19:00 PDT; DST ends 11-01 02:00, so 08:00 Sun is PST = 16:00Z.
    const row = event({ endsAt: '2026-11-01T02:00:00.000Z' });
    expect(isDue(row, new Date('2026-11-01T16:00:00Z'), cfg)).toBe(true);
    expect(isDue(row, new Date('2026-11-01T15:59:59Z'), cfg)).toBe(false);
  });

  it('is not due the same Pacific evening, even after 08:00 UTC-equivalent', () => {
    // Ends Sun 10-25 09:00 PDT; next morning is Mon 10-26 08:00 PDT, not later that Sunday.
    const row = event({ endsAt: '2026-10-25T16:00:00.000Z' });
    expect(isDue(row, new Date('2026-10-25T23:00:00Z'), cfg)).toBe(false);
    expect(isDue(row, new Date('2026-10-26T15:00:00Z'), cfg)).toBe(true);
  });

  it('is false for a class that ended more than maxAgeDays ago', () => {
    const row = event({ endsAt: '2026-10-21T02:00:00.000Z' });
    expect(isDue(row, new Date('2026-10-25T15:00:00Z'), cfg)).toBe(false);
  });

  // Eventbrite reports a canceled-then-removed event as `deleted` (seen in the 2026-10-26 sandbox
  // rehearsal), so only statuses of an event that ran are due.
  it.each(['canceled', 'deleted', 'draft', null])('is false for an event with status %s', (status) => {
    expect(isDue(event({ eventbriteStatus: status }), new Date('2026-10-25T15:00:00Z'), cfg)).toBe(false);
  });

  it.each(['live', 'started', 'ended', 'completed'])('is true for an event with status %s', (status) => {
    expect(isDue(event({ eventbriteStatus: status }), new Date('2026-10-25T15:00:00Z'), cfg)).toBe(true);
  });

  it('is false with no end time', () => {
    expect(isDue(event({ endsAt: null }), new Date('2026-10-25T15:00:00Z'), cfg)).toBe(false);
  });
});

function reg(itemId: string, attendance: string, email = `${itemId}@example.com`): Registration {
  return { itemId, attendance, email };
}

describe('planFollowups', () => {
  it('holds when nobody is Attended', () => {
    const regs = Array.from({ length: 29 }, (_, i) => reg(`r${i}`, 'Registered'));
    expect(planFollowups(regs, 'Learn to Ride')).toEqual({ outcome: 'held' });
  });

  it('thanks the Attended and misses the Registered, marking them No Show', () => {
    const regs = [
      ...Array.from({ length: 2 }, (_, i) => reg(`a${i}`, 'Attended')),
      ...Array.from({ length: 12 }, (_, i) => reg(`m${i}`, 'Registered')),
    ];
    const plan = planFollowups(regs, 'Learn to Ride');
    if (plan.outcome !== 'send') throw new Error('expected send');
    const thanks = plan.writes.filter((w) => w.label === 'Thank-you: Learn to Ride');
    const missed = plan.writes.filter((w) => w.label === 'Missed-you: Learn to Ride');
    expect(thanks).toHaveLength(2);
    expect(thanks.every((w) => !w.noShow)).toBe(true);
    expect(missed).toHaveLength(12);
    expect(missed.every((w) => w.noShow)).toBe(true);
    expect(plan.writes).toHaveLength(14);
  });

  it('writes nothing for Canceled, No Show, or a registration without an email', () => {
    const plan = planFollowups(
      [reg('a', 'Attended'), reg('c', 'Canceled'), reg('n', 'No Show'), reg('x', 'Registered', ''), reg('y', 'Attended', '  ')],
      'Commute'
    );
    expect(plan).toEqual({ outcome: 'send', writes: [{ itemId: 'a', label: 'Thank-you: Commute', noShow: false }] });
  });

  it('sends one thank-you to a parent whose two kids share an email, one Attended and one Registered', () => {
    const plan = planFollowups([reg('kid1', 'Registered', 'parent@example.com'), reg('kid2', 'Attended', 'parent@example.com')], 'Family Ride');
    expect(plan).toEqual({ outcome: 'send', writes: [{ itemId: 'kid2', label: 'Thank-you: Family Ride', noShow: false }] });
  });

  it('dedupes emails case- and whitespace-insensitively, keeping the first item seen', () => {
    const plan = planFollowups(
      [reg('a1', 'Attended', 'Pat@Example.com'), reg('a2', 'Attended', ' pat@example.COM '), reg('m1', 'Registered', 'Lee@x.org'), reg('m2', 'Registered', 'lee@x.org')],
      'Commute'
    );
    expect(plan).toEqual({
      outcome: 'send',
      writes: [
        { itemId: 'a1', label: 'Thank-you: Commute', noShow: false },
        { itemId: 'm1', label: 'Missed-you: Commute', noShow: true },
      ],
    });
  });

  it('skips an address that already has a Follow-up Email label (a retry after a crash)', () => {
    // First run wrote missed-you on m1 (now No Show) and crashed before Sent. On the retry its
    // Registered sibling on the same address must not get a second missed-you, and the
    // already-thanked a1 is not re-written.
    const plan = planFollowups(
      [
        { itemId: 'a1', attendance: 'Attended', email: 'pat@x.org', followupEmail: 'Thank-you: Commute' },
        { itemId: 'm1', attendance: 'No Show', email: 'fam@x.org', followupEmail: 'Missed-you: Commute' },
        { itemId: 'm2', attendance: 'Registered', email: 'FAM@x.org' },
        { itemId: 'm3', attendance: 'Registered', email: 'new@x.org', followupEmail: '' },
      ],
      'Commute'
    );
    expect(plan).toEqual({ outcome: 'send', writes: [{ itemId: 'm3', label: 'Missed-you: Commute', noShow: true }] });
  });

  it('sends when the only Attended registration has no email', () => {
    // The Held guard is about check-ins, not addresses: an Attended registrant with no email
    // still proves check-in happened, so the Registered ones get missed-you.
    const plan = planFollowups([reg('a', 'Attended', ''), reg('m', 'Registered')], 'Commute');
    expect(plan).toEqual({ outcome: 'send', writes: [{ itemId: 'm', label: 'Missed-you: Commute', noShow: true }] });
  });
});
