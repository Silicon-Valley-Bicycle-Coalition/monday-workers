import { describe, it, expect } from 'vitest';
import {
  planBackfill, remapSql, reconcile, volunteerColumnValues, parseLedger, ledgerLine, statusLabel, isoDate,
} from './backfill-volunteers-lib.mjs';
import { testConfig } from '../src/test/testConfig';

const vc = testConfig().attendeeSync.volunteers;

const reg = (itemId, over = {}) => ({
  itemId, attendeeId: `a${itemId}`, role: 'Volunteer', attendance: 'Registered', eventItemId: '900',
  personItemId: null, name: `Name ${itemId}`, email: `${itemId}@v.org`, ...over,
});
const listings = new Map([
  ['900', { name: 'Trail Work Day', date: '2026-10-30', program: 'Volunteering' }],
  ['901', { name: 'Bike Class', date: '2026-10-31', program: 'Public' }],
]);

describe('planBackfill', () => {
  it('plans a Volunteers item with Event and Eventbrite Listing both the registration\'s Events item', () => {
    const { create, skipped } = planBackfill([reg('1', { personItemId: '77' })], listings, new Set());
    expect(skipped).toEqual([]);
    expect(create).toEqual([{
      registrationItemId: '1', attendeeId: 'a1', eventItemId: '900', listingItemId: '900', personItemId: '77',
      itemName: 'Name 1', name: 'Name 1', email: '1@v.org', job: 'Trail Work Day', date: '2026-10-30', status: 'RSVP',
    }]);
    expect(create[0].eventItemId).toBe(create[0].listingItemId);
  });

  it.each([
    ['Registered', 'RSVP'], ['Attended', 'Completed'], ['Canceled', 'Canceled'], ['No Show', 'No-Show'],
  ])('maps Attendance %s to Status %s through the shared mapping', (attendance, status) => {
    expect(planBackfill([reg('1', { attendance })], listings, new Set()).create[0].status).toBe(status);
  });

  it('skips a registration with no attendee id', () => {
    const { create, skipped } = planBackfill([reg('1', { attendeeId: null }), reg('2', { attendeeId: '  ' })], listings, new Set());
    expect(create).toEqual([]);
    expect(skipped).toEqual([{ itemId: '1', reason: 'no-attendee-id' }, { itemId: '2', reason: 'no-attendee-id' }]);
  });

  it('skips a registration whose listing is not a Volunteering event, or has no or an unknown listing', () => {
    const { create, skipped } = planBackfill(
      [reg('1', { eventItemId: '901' }), reg('2', { eventItemId: null }), reg('3', { eventItemId: '999' })], listings, new Set());
    expect(create).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(['not-a-volunteering-event', 'not-a-volunteering-event', 'not-a-volunteering-event']);
  });

  it('honours a fork\'s own volunteer programs', () => {
    const { create } = planBackfill([reg('1', { eventItemId: '901' })], listings, new Set(), ['Public']);
    expect(create).toHaveLength(1);
  });

  it('skips an attendee already on the Volunteers board, so a re-run creates nothing', () => {
    const regs = [reg('1'), reg('2')];
    const first = planBackfill(regs, listings, new Set());
    const rerun = planBackfill(regs, listings, new Set(first.create.map((p) => p.attendeeId)));
    expect(rerun.create).toEqual([]);
    expect(rerun.skipped).toEqual([{ itemId: '1', reason: 'already-moved' }, { itemId: '2', reason: 'already-moved' }]);
  });

  it('creates one item for a duplicate registration of the same attendee', () => {
    const { create, skipped } = planBackfill([reg('1'), reg('2', { attendeeId: 'a1' })], listings, new Set());
    expect(create.map((p) => p.registrationItemId)).toEqual(['1']);
    expect(skipped).toEqual([{ itemId: '2', reason: 'already-moved' }]);
  });

  it('ignores registrations whose Role is not Volunteer', () => {
    expect(planBackfill([reg('1', { role: 'Participant' })], listings, new Set())).toEqual({ create: [], skipped: [] });
  });

  it('names an unnamed attendee by id and leaves Date blank when the event has none', () => {
    const noDate = new Map([['900', { name: 'Shift', date: null, program: 'Volunteering' }]]);
    const [plan] = planBackfill([reg('1', { name: '', email: null })], noDate, new Set()).create;
    expect(plan.itemName).toBe('Eventbrite attendee a1');
    expect(plan.name).toBeNull();
    expect(plan.date).toBeNull();
  });
});

describe('volunteerColumnValues', () => {
  it('writes every column, Historical unchecked, both relations to the Events item', () => {
    const [plan] = planBackfill([reg('1', { personItemId: '77', attendance: 'No Show' })], listings, new Set()).create;
    expect(volunteerColumnValues(plan, vc)).toEqual({
      [vc.attendeeIdColumn]: 'a1',
      [vc.statusColumn]: 'No-Show',
      [vc.jobColumn]: 'Trail Work Day',
      [vc.historicalColumn]: { checked: 'false' },
      [vc.dateColumn]: { date: '2026-10-30' },
      [vc.attendeeNameColumn]: 'Name 1',
      [vc.attendeeEmailColumn]: { email: '1@v.org', text: '1@v.org' },
      [vc.eventColumn]: { item_ids: [900] },
      [vc.listingColumn]: { item_ids: [900] },
      [vc.volunteerLinkColumn]: { item_ids: [77] },
    });
  });

  it('leaves Volunteer, Date, name and email out when they are unknown', () => {
    const noDate = new Map([['900', { name: 'Shift', date: null, program: 'Volunteering' }]]);
    const [plan] = planBackfill([reg('1', { name: '', email: null })], noDate, new Set()).create;
    const values = volunteerColumnValues(plan, vc);
    for (const col of [vc.volunteerLinkColumn, vc.dateColumn, vc.attendeeNameColumn, vc.attendeeEmailColumn]) {
      expect(values).not.toHaveProperty(col);
    }
  });
});

describe('remapSql', () => {
  it('rewrites the attendee ledger by attendee id and the class-email ledger by old item id', () => {
    const sql = remapSql([{ attendeeId: 'a1', oldItemId: '100', newItemId: '200' }]);
    expect(sql).toContain("UPDATE attendees SET monday_item_id = '200' WHERE attendee_id = 'a1';");
    expect(sql).toContain("UPDATE class_email_recipients SET registration_item_id = '200' WHERE registration_item_id = '100';");
  });

  it('escapes a quote', () => {
    const sql = remapSql([{ attendeeId: "o'b", oldItemId: "1'", newItemId: '2' }]);
    expect(sql).toContain("WHERE attendee_id = 'o''b';");
    expect(sql).toContain("WHERE registration_item_id = '1''';");
  });

  it('puts one statement per line, so D1 exec and wrangler --file both read it', () => {
    const lines = remapSql([{ attendeeId: 'a1', oldItemId: '1', newItemId: '2' }, { attendeeId: 'a2', oldItemId: '3', newItemId: '4' }])
      .split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toMatch(/^UPDATE .*;$/);
  });
});

describe('reconcile', () => {
  it('lists the moves and passes when every eligible attendee is on the Volunteers board', () => {
    const regs = [reg('1'), reg('2'), reg('3', { attendeeId: null }), reg('4', { eventItemId: '901' })];
    const r = reconcile(regs, listings, new Map([['a1', '501'], ['a2', '502']]));
    expect(r.moves).toEqual([{ attendeeId: 'a1', oldItemId: '1', newItemId: '501' }, { attendeeId: 'a2', oldItemId: '2', newItemId: '502' }]);
    expect(r).toMatchObject({ eligible: 2, present: 2, ok: true, toArchive: ['1', '2'], missing: [] });
  });

  it('fails the count check when an eligible registration has no Volunteers item, and archives nothing', () => {
    const r = reconcile([reg('1'), reg('2')], listings, new Map([['a1', '501']]));
    expect(r).toMatchObject({ eligible: 2, present: 1, ok: false, toArchive: [], missing: ['2'] });
    expect(r.moves).toEqual([{ attendeeId: 'a1', oldItemId: '1', newItemId: '501' }]);
  });

  it('moves and archives every registration of a duplicated attendee onto its one item', () => {
    const r = reconcile([reg('1'), reg('2', { attendeeId: 'a1' })], listings, new Map([['a1', '501']]));
    expect(r.moves.map((m) => m.oldItemId)).toEqual(['1', '2']);
    expect(r).toMatchObject({ eligible: 1, present: 1, ok: true, toArchive: ['1', '2'] });
  });

  it('is not ok with nothing eligible', () => {
    expect(reconcile([], listings, new Map()).ok).toBe(false);
  });
});

describe('ledger', () => {
  it('round-trips lines and ignores blanks and a torn last line', () => {
    const text = ledgerLine({ attendeeId: 'a1', registrationItemId: '1', volunteerItemId: '501' })
      + '\n' + ledgerLine({ attendeeId: 'a2', registrationItemId: '2', volunteerItemId: '502' }) + '{"attendeeId":"a3"';
    expect(parseLedger(text)).toEqual(new Map([['a1', '501'], ['a2', '502']]));
    expect(parseLedger('')).toEqual(new Map());
  });
});

describe('statusLabel', () => {
  it('reads the label only when the stored value has an index', () => {
    expect(statusLabel('No Show', '{"index":2}')).toBe('No Show');
    expect(statusLabel('Registered', null)).toBe('');
    expect(statusLabel('Registered', '{}')).toBe('');
    expect(statusLabel('Registered', 'not json')).toBe('');
  });
});

describe('isoDate', () => {
  it('keeps the date part of a date cell', () => {
    expect(isoDate('2026-10-30')).toBe('2026-10-30');
    expect(isoDate('2026-10-30 09:00')).toBe('2026-10-30');
    expect(isoDate('')).toBeNull();
    expect(isoDate(null)).toBeNull();
  });
});
