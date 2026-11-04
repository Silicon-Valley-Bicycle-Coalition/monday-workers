import { describe, it, expect } from 'vitest';
import { planKind, type ClassFacts, type RosterEntry } from './plan';
import type { ClassEmailRow } from '../db/classEmails';

const STARTS = '2026-11-10T18:00:00.000Z';
const ENDS = '2026-11-10T20:00:00.000Z';
const BEFORE = new Date('2026-11-09T12:00:00.000Z');
const DURING = new Date('2026-11-10T19:00:00.000Z');
const AFTER = new Date('2026-11-11T12:00:00.000Z');

const facts: ClassFacts = { startsAt: STARTS, endsAt: ENDS, eventbriteStatus: 'live' };

function entry(id: string, attendance: string, over: Partial<RosterEntry> = {}): RosterEntry {
  return { registrationId: id, attendance, role: 'Participant', email: `${id}@x.org`, firstName: `F${id}`, name: `F${id} L`, ...over };
}

function row(id: string, status: ClassEmailRow['status'], kind: ClassEmailRow['kind'] = 'reminder'): ClassEmailRow {
  return { eventId: 'e1', kind, registrationId: id, status, claimedAt: '2026-11-09T00:00:00.000Z', resolvedAt: status === 'claimed' ? null : '2026-11-09T00:01:00.000Z' };
}

const ids = (p: { recipients: { registrationId: string }[] }) => p.recipients.map((r) => r.registrationId);

describe('planKind', () => {
  it('reminder goes to Registered participants', () => {
    const roster = [entry('a', 'Registered'), entry('b', 'Attended'), entry('c', 'No Show'), entry('d', 'Canceled')];
    const plan = planKind('reminder', facts, roster, [], BEFORE);
    expect(plan.refusal).toBeNull();
    expect(ids(plan)).toEqual(['a']);
  });

  it('excludes volunteers and blank emails', () => {
    const roster = [
      entry('a', 'Registered'),
      entry('b', 'Registered', { role: 'Volunteer' }),
      entry('c', 'Registered', { email: '' }),
      entry('d', 'Registered', { email: '   ' }),
    ];
    expect(ids(planKind('reminder', facts, roster, [], BEFORE))).toEqual(['a']);
  });

  it('reminder refused once the class has started', () => {
    const roster = [entry('a', 'Registered')];
    for (const now of [new Date(STARTS), DURING, AFTER]) {
      const plan = planKind('reminder', facts, roster, [], now);
      expect(plan.refusal).not.toBeNull();
      expect(plan.recipients).toEqual([]);
    }
  });

  it('thank-you and missed-you refused before the class ends', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'No Show')];
    for (const kind of ['thank-you', 'missed-you'] as const) {
      for (const now of [BEFORE, DURING]) {
        const plan = planKind(kind, facts, roster, [], now);
        expect(plan.refusal).not.toBeNull();
        expect(plan.recipients).toEqual([]);
      }
      expect(planKind(kind, facts, roster, [], new Date(ENDS)).refusal).toBeNull();
    }
  });

  it('thank-you and missed-you refused when nobody Attended', () => {
    const roster = [entry('a', 'Registered'), entry('b', 'No Show')];
    for (const kind of ['thank-you', 'missed-you'] as const) {
      const plan = planKind(kind, facts, roster, [], AFTER);
      expect(plan.refusal).toContain('checked in');
      expect(plan.recipients).toEqual([]);
    }
  });

  it('an Attended volunteer alone does not satisfy the check-in guard', () => {
    const roster = [entry('v', 'Attended', { role: 'Volunteer' }), entry('a', 'Registered')];
    for (const kind of ['thank-you', 'missed-you'] as const) {
      const plan = planKind(kind, facts, roster, [], AFTER);
      expect(plan.refusal).toContain('checked in');
      expect(plan.recipients).toEqual([]);
    }
  });

  it('an Attended row with a blank email alone does not satisfy the check-in guard', () => {
    for (const email of ['', '   ']) {
      const roster = [entry('b', 'Attended', { email }), entry('a', 'Registered')];
      for (const kind of ['thank-you', 'missed-you'] as const) {
        const plan = planKind(kind, facts, roster, [], AFTER);
        expect(plan.refusal).toContain('checked in');
        expect(plan.recipients).toEqual([]);
      }
    }
  });

  it("a volunteer's Attended address doesn't block a participant's missed-you", () => {
    const roster = [
      entry('p', 'Attended'),
      entry('v', 'Attended', { role: 'Volunteer', email: 'shared@x.org' }),
      entry('a', 'Registered', { email: 'Shared@x.org' }),
    ];
    expect(ids(planKind('missed-you', facts, roster, [], AFTER))).toEqual(['a']);
  });

  it('thank-you goes to Attended only', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'Registered'), entry('c', 'No Show'), entry('d', 'Canceled')];
    expect(ids(planKind('thank-you', facts, roster, [], AFTER))).toEqual(['a']);
  });

  it('missed-you goes to Registered and No Show', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'Registered'), entry('c', 'No Show'), entry('d', 'Canceled')];
    const plan = planKind('missed-you', facts, roster, [], AFTER);
    expect(plan.refusal).toBeNull();
    expect(ids(plan)).toEqual(['b', 'c']);
  });

  it('canceled or deleted event refuses every kind', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'Registered'), entry('c', 'No Show')];
    for (const eventbriteStatus of ['canceled', 'deleted']) {
      for (const kind of ['reminder', 'thank-you', 'missed-you'] as const) {
        const plan = planKind(kind, { ...facts, eventbriteStatus }, roster, [], kind === 'reminder' ? BEFORE : AFTER);
        expect(plan.refusal).not.toBeNull();
        expect(plan.recipients).toEqual([]);
      }
    }
  });

  it('only live, started, ended and completed events may send', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'Registered')];
    for (const eventbriteStatus of ['live', 'started', 'ended', 'completed']) {
      expect(planKind('thank-you', { ...facts, eventbriteStatus }, roster, [], AFTER).refusal, eventbriteStatus).toBeNull();
      expect(planKind('reminder', { ...facts, eventbriteStatus }, roster, [], BEFORE).refusal, eventbriteStatus).toBeNull();
    }
  });

  it('draft, null, blank and unknown statuses refuse every kind, with a clear reason', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'Registered')];
    const cases: [string | null, RegExp][] = [['draft', /draft/], [null, /no Eventbrite status/], ['', /no Eventbrite status/], ['postponed', /postponed/], ['LIVE', /LIVE/]];
    for (const [eventbriteStatus, reason] of cases) {
      for (const kind of ['reminder', 'thank-you', 'missed-you'] as const) {
        const plan = planKind(kind, { ...facts, eventbriteStatus }, roster, [], kind === 'reminder' ? BEFORE : AFTER);
        expect(plan.refusal, String(eventbriteStatus)).toMatch(reason);
        expect(plan.recipients).toEqual([]);
      }
    }
  });

  it('canceled and deleted keep their plain wording', () => {
    for (const eventbriteStatus of ['canceled', 'deleted']) {
      expect(planKind('reminder', { ...facts, eventbriteStatus }, [entry('a', 'Registered')], [], BEFORE).refusal).toBe(`This class is ${eventbriteStatus} on Eventbrite, so no emails can be sent.`);
    }
  });

  it('null dates refuse', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'Registered')];
    expect(planKind('reminder', { ...facts, startsAt: null }, roster, [], BEFORE).refusal).not.toBeNull();
    for (const kind of ['thank-you', 'missed-you'] as const) {
      expect(planKind(kind, { ...facts, endsAt: null }, roster, [], AFTER).refusal).not.toBeNull();
    }
  });

  it('unparseable dates refuse', () => {
    const roster = [entry('a', 'Attended'), entry('b', 'Registered')];
    expect(planKind('reminder', { ...facts, startsAt: 'soon' }, roster, [], BEFORE).refusal).not.toBeNull();
    expect(planKind('thank-you', { ...facts, endsAt: 'later' }, roster, [], AFTER).refusal).not.toBeNull();
  });

  it('one email per address, ignoring case and spaces', () => {
    const roster = [
      entry('a', 'Registered', { email: 'A@x.org' }),
      entry('b', 'Registered', { email: ' a@X.org ' }),
      entry('c', 'Registered', { email: 'c@x.org' }),
    ];
    const plan = planKind('reminder', facts, roster, [], BEFORE);
    expect(ids(plan)).toEqual(['a', 'c']);
  });

  it('an address with any Attended gets no missed-you', () => {
    const roster = [
      entry('a', 'Attended', { email: 'sam@x.org' }),
      entry('b', 'Registered', { email: 'Sam@x.org' }),
      entry('c', 'No Show', { email: 'other@x.org' }),
    ];
    expect(ids(planKind('thank-you', facts, roster, [], AFTER))).toEqual(['a']);
    expect(ids(planKind('missed-you', facts, roster, [], AFTER))).toEqual(['c']);
  });

  it('ledger rows are excluded and counted', () => {
    const roster = [entry('a', 'Registered'), entry('b', 'Registered'), entry('c', 'Registered'), entry('d', 'Registered')];
    const ledger = [row('a', 'sent'), row('b', 'claimed'), row('c', 'failed')];
    const plan = planKind('reminder', facts, roster, ledger, BEFORE);
    expect(plan.sent).toBe(1);
    expect(plan.unresolved.map((u) => u.registrationId)).toEqual(['b', 'c']);
    expect(plan.unresolved[0]).toEqual({ registrationId: 'b', email: 'b@x.org', firstName: 'Fb', name: 'Fb L' });
    expect(ids(plan)).toEqual(['d']);
  });

  it('only ledger rows for this kind count', () => {
    const roster = [entry('a', 'Registered')];
    const ledger = [row('a', 'sent', 'thank-you'), row('a', 'claimed', 'missed-you')];
    const plan = planKind('reminder', facts, roster, ledger, BEFORE);
    expect(plan.sent).toBe(0);
    expect(plan.unresolved).toEqual([]);
    expect(ids(plan)).toEqual(['a']);
  });

  it('a sibling on a claimed address is not picked', () => {
    const roster = [
      entry('a', 'Registered', { email: 'sam@x.org' }),
      entry('b', 'Registered', { email: ' SAM@x.org' }),
      entry('c', 'Registered', { email: 'c@x.org' }),
    ];
    for (const status of ['claimed', 'sent', 'failed'] as const) {
      const plan = planKind('reminder', facts, roster, [row('a', status)], BEFORE);
      expect(ids(plan)).toEqual(['c']);
    }
  });

  it('a ledger row off the roster stays unresolved with blank details', () => {
    const roster = [entry('a', 'Registered')];
    const ledger = [row('gone', 'claimed'), row('gone2', 'failed'), row('gone3', 'sent')];
    const plan = planKind('reminder', facts, roster, ledger, BEFORE);
    expect(plan.unresolved).toEqual([
      { registrationId: 'gone', email: '', firstName: '', name: '' },
      { registrationId: 'gone2', email: '', firstName: '', name: '' },
    ]);
    expect(plan.sent).toBe(1);
    expect(ids(plan)).toEqual(['a']);
  });

  it('a refusal still reports sent and unresolved', () => {
    const roster = [entry('a', 'Registered'), entry('b', 'Registered')];
    const plan = planKind('reminder', facts, roster, [row('a', 'sent'), row('b', 'failed')], DURING);
    expect(plan.refusal).not.toBeNull();
    expect(plan.recipients).toEqual([]);
    expect(plan.sent).toBe(1);
    expect(plan.unresolved.map((u) => u.registrationId)).toEqual(['b']);
  });

  it('a recipient with a blank first name stays listed', () => {
    const roster = [entry('a', 'Registered', { firstName: '' })];
    const plan = planKind('reminder', facts, roster, [], BEFORE);
    expect(plan.recipients).toEqual([{ registrationId: 'a', email: 'a@x.org', firstName: '', name: 'Fa L' }]);
  });
});
