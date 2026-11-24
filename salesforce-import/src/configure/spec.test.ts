import { describe, it, expect } from 'vitest';
import { BOARD_SPECS, PLUMBING, DASHBOARD_SPECS, withReceivedRule } from './spec.js';
import type { WidgetSpec } from './widgets.js';
import { DONATION_STATUS_LABELS, STATUS_LABELS } from '../load/boards.js';

describe('BOARD_SPECS columns', () => {
  it('Stakeholder Type carries exactly the labels load seeds, so whichever step creates it agrees (#46)', () => {
    const col = BOARD_SPECS['people-live']!.columns!.find((c) => c.title === 'Stakeholder Type')!;
    expect(col.type).toBe('status');
    expect(col.labels).toEqual(STATUS_LABELS['Stakeholder Type']);
    expect(col.labels).toContain('Elected Official');
  });

  it('the two People boards get the same columns, so people-reclassification can move between them', () => {
    // A column on one People board but not the other makes every reclassification pass abort
    // (it would drop that column's values). Campaign (tags) was live-only until 2026-11-02.
    const cols = (key: string) => (BOARD_SPECS[key]!.columns ?? []).map((c) => `${c.title} (${c.type})`).sort();
    expect(cols('people-historical')).toEqual(cols('people-live'));
  });
  it('People boards carry First Name and Last Name as text', () => {
    const cols = (BOARD_SPECS['people-live']!.columns ?? []).map((c) => `${c.title} (${c.type})`);
    expect(cols).toEqual(expect.arrayContaining(['First Name (text)', 'Last Name (text)']));
  });
  it('attendee list views show what a mail merge needs', () => {
    for (const name of ['By event', 'Attended']) {
      const view = BOARD_SPECS['event-registrations']!.views!.find((v) => v.name === name)!;
      expect(view.columns).toEqual(expect.arrayContaining(['First Name', 'Attendee Email']));
    }
  });
});

describe('Possible Duplicate flag (#54)', () => {
  const PEOPLE_BOARDS = ['people-live', 'people-historical'];

  it('is a status column with the agreed labels on both People boards, and leaves blank as unflagged', () => {
    for (const b of PEOPLE_BOARDS) {
      expect(BOARD_SPECS[b]!.columns, b).toContainEqual(
        { title: 'Possible Duplicate', type: 'status', labels: ['Possible Duplicate', 'Merged', 'Not a Duplicate'] });
    }
  });

  it('tells staff what the flag does on both boards', () => {
    for (const b of PEOPLE_BOARDS) {
      expect(BOARD_SPECS[b]!.columnDescriptions!['Possible Duplicate'], b).toMatch(/David/);
    }
  });

  it('has a worklist on both boards holding only open flags, with same-named records side by side', () => {
    for (const b of PEOPLE_BOARDS) {
      const view = BOARD_SPECS[b]!.views!.find((v) => v.name === 'Possible duplicates')!;
      expect(view.tag, b).toBe('Worklist');
      expect(view.filter!.rules, b).toEqual(
        [{ columnTitle: 'Possible Duplicate', operator: 'any_of', labelValues: ['Possible Duplicate'] }]);
      expect(view.sort, b).toEqual([{ columnTitle: 'Name' }]);
    }
  });
});

describe('Event Registrations class roster', () => {
  const spec = BOARD_SPECS['event-registrations']!;
  const roster = spec.views!.find((v) => v.name === 'Class roster')!;

  it('creates every per-attendee column eventbrite-sync writes that the load does not', () => {
    expect(spec.columns).toEqual([
      { title: 'Attendee Phone', type: 'text' },
      { title: 'First Name', type: 'text' },
      { title: 'Class Date', type: 'date' },
      { title: 'Class Day', type: 'text' },
      { title: 'Class Location', type: 'text' },
    ]);
  });

  it('lists only people still registered for a class that has not happened yet', () => {
    expect(roster.filter!.rules).toEqual([
      { columnTitle: 'Attendance', operator: 'any_of', labelValues: ['Registered'] },
      { columnTitle: 'Class Date', operator: 'greater_than_or_equals', compareValue: ['TODAY'] },
    ]);
  });

  it('groups by class, soonest first, with the fields staff need to reach someone', () => {
    expect(roster.groupBy).toEqual({ columnTitle: 'Event' });
    expect(roster.sort).toEqual([{ columnTitle: 'Class Date' }]);
    expect(roster.columns).toEqual(expect.arrayContaining(['Attendee Name', 'Attendee Email', 'Class Date']));
  });
});

describe('Events send link', () => {
  it('has a Send class email link column, written by eventbrite-sync', () => {
    expect(BOARD_SPECS['events']!.columns).toContainEqual({ title: 'Send class email', type: 'link' });
  });
});

describe('BOARD_SPECS views', () => {
  const all = Object.entries(BOARD_SPECS).flatMap(([board, s]) => (s.views ?? []).map((v) => ({ board, v })));

  it('Drafts to confirm shows the Current/Former that impact-attribution proposed', () => {
    const view = BOARD_SPECS['affiliations']!.views!.find((v) => v.name === 'Drafts to confirm')!;
    expect(view.columns).toEqual(['Person', 'Organization', 'Proposed status', 'Affiliation Role', 'Start', 'Work Email']);
  });

  it('every view has exactly one tag', () => {
    for (const { board, v } of all) expect(v.tag, `${board} / ${v.name}`).toMatch(/^(Worklist|Report|Reference)$/);
  });

  it('no working view shows a plumbing column', () => {
    for (const { board, v } of all) for (const col of v.columns ?? []) expect(PLUMBING, `${board} / ${v.name}`).not.toContain(col);
  });

  it('working views show 3–9 columns besides Name', () => {
    for (const { board, v } of all) if (v.columns) expect(v.columns.length, `${board} / ${v.name}`).toBeGreaterThanOrEqual(3);
    for (const { board, v } of all) if (v.columns) expect(v.columns.length, `${board} / ${v.name}`).toBeLessThanOrEqual(9);
  });

  it('view names are unique per board', () => {
    for (const s of Object.values(BOARD_SPECS)) {
      const names = (s.views ?? []).map((v) => v.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('lookup boards open on a flat Find view, sorted by Name (#51)', () => {
    const first = (k: string) => BOARD_SPECS[k]!.views![0]!;
    expect(first('people-live').name).toBe('Find a person');
    expect(first('people-historical').name).toBe('Find a person');
    expect(first('organizations').name).toBe('Find an organization');
    for (const k of ['people-live', 'people-historical', 'organizations']) {
      const v = first(k);
      expect(v.tag, k).toBe('Reference');
      expect(v.filter, k).toBeUndefined();
      expect(v.groupBy, k).toBeUndefined();
      expect(v.sort, k).toEqual([{ columnTitle: 'Name' }]);
    }
  });

  it('has the report replacements from the Salesforce usage survey', () => {
    const names = (k: string) => (BOARD_SPECS[k]!.views ?? []).map((v) => v.name);
    expect(names('people-live')).toEqual(expect.arrayContaining(
      ['New donors this FY, $200+', 'Donors', 'Major donors', 'Donors to target', 'Gave last year, not this year', 'Appeal list', 'Members', 'By city']));
    expect(names('event-registrations')).toContain('Volunteers, last 12 months');
    expect(names('donations')).toEqual(expect.arrayContaining(
      ['Recent gifts', 'Revenue by funding stream', 'By gift size', 'By fiscal quarter', 'Major gifts to thank']));
  });

  it('"Postal appeal list" needs an address and suppresses Do Not Solicit and Do Not Mail', () => {
    const v = BOARD_SPECS['people-live']!.views!.find((x) => x.name === 'Postal appeal list')!;
    const rules = v.filter!.rules.map((r) => `${r.columnTitle} ${r.operator}`);
    expect(rules).toEqual(expect.arrayContaining(
      ['Address is_not_empty', 'Do Not Solicit is_empty', 'Do Not Mail is_empty', 'Gift Count greater_than',
        'Has Active Recurring Gift is_empty']));
    expect(rules.some((r) => r.startsWith('Personal Email'))).toBe(false);
  });
});

describe('report-triage views (docs/35 §3.4, §3.5)', () => {
  const view = (name: string) => BOARD_SPECS['people-live']!.views!.find((x) => x.name === name)!;

  it('the board donor call list needs a phone and suppresses Do Not Solicit', () => {
    const rules = view('Board donor call list').filter!.rules.map((r) => `${r.columnTitle} ${r.operator}`);
    expect(rules).toEqual(expect.arrayContaining(['Phone is_not_empty', 'Do Not Solicit is_empty',
      'Last Gift Date within_the_last']));
  });

  it('the 990 view reads the last-fiscal-year rollup', () => {
    expect(view('Gave last fiscal year (990)').filter!.rules[0]).toMatchObject(
      { columnTitle: 'Last Year Amount', operator: 'greater_than' });
  });

  it('donor portfolios group by Relationship Owner, which both People boards describe', () => {
    expect(view('Donor portfolios').groupBy).toEqual({ columnTitle: 'Relationship Owner' });
    for (const b of ['people-live', 'people-historical']) {
      expect(BOARD_SPECS[b]!.columnDescriptions!['Relationship Owner'], b).toBeTruthy();
    }
  });
});

describe('DASHBOARD_SPECS revenue filters', () => {
  const widgets = DASHBOARD_SPECS.flatMap((d) => d.widgets.map((w) => ({ d: d.name, w })));
  const onDonations = widgets.filter(({ w }) => w.chart?.board === 'donations' || w.number?.boards.includes('donations'));

  it('finds the donations widgets', () => { expect(onDonations.length).toBeGreaterThanOrEqual(6); });

  it('every donations widget counts only Received gifts', () => {
    for (const { d, w } of onDonations) {
      expect(w.filter?.board, `${d} / ${w.name}`).toBe('donations');
      expect(w.filter?.rules, `${d} / ${w.name}`).toContainEqual(
        { columnTitle: 'Status', operator: 'any_of', labelValues: ['Received'] });
    }
  });

  it('keeps existing filters (Major gifts not yet thanked)', () => {
    const w = widgets.find(({ w }) => w.name === 'Major gifts not yet thanked')!.w;
    expect(w.filter?.rules.map((r) => r.columnTitle)).toEqual(expect.arrayContaining(['Acknowledgment Tier', 'Thank You Sent', 'Status']));
  });
});

describe('final-review spec rulings', () => {
  const view = (b: string, n: string) => BOARD_SPECS[b]!.views!.find((v) => v.name === n)!;

  it('"Upcoming" events need the Upcoming status and a Date of today or later, so a stale status drops out', () => {
    expect(view('events', 'Upcoming').filter!.rules).toEqual([
      { columnTitle: 'Event Status', operator: 'any_of', labelValues: ['Upcoming'] },
      { columnTitle: 'Date', operator: 'greater_than_or_equals', compareValue: ['TODAY'] },
    ]);
  });

  it('"Gave last year, not this year" keys on This Year Count < 1 (rollups write 0.00, never blank)', () => {
    const rules = view('people-live', 'Gave last year, not this year').filter!.rules;
    expect(rules).toContainEqual({ columnTitle: 'This Year Count', operator: 'lower_than', compareValue: 1 });
    expect(rules.map((r) => r.columnTitle)).not.toContain('This Year Amount');
  });

  it('"Recent gifts" has no colouring (red means needs action)', () => {
    expect(view('donations', 'Recent gifts').coloring).toBeUndefined();
  });

  it('names Donor Advised Fund in the Gift Type vocabulary staff type from', () => {
    expect(BOARD_SPECS['donations']!.columnDescriptions!['Gift Type']).toContain('Donor Advised Fund');
  });

  it('describes the computed columns as rollup-owned', () => {
    for (const b of ['people-live', 'organizations']) expect(BOARD_SPECS[b]!.columnDescriptions!['Donor Level']).toMatch(/Leadership.*Overwritten|Edits are overwritten/s);
    for (const c of ['Funding Stream', 'Gift Size', 'Fiscal Quarter', 'Gift Fiscal Year'])
      expect(BOARD_SPECS['donations']!.columnDescriptions![c]).toMatch(/donation-rollups integration from Gift Type, Amount, and Date\. Edits are overwritten\.$/);
  });
});

describe('withReceivedRule', () => {
  const received = (w: WidgetSpec) => (w.filter?.rules ?? []).filter((r) => r.columnTitle === 'Status' && r.labelValues?.includes('Received')).length;
  const num = (over: Partial<WidgetSpec> = {}): WidgetSpec => ({ name: 'w', kind: 'NUMBER', number: { boards: ['donations'], count: true }, ...over });

  it('adds Received to NUMBER, CHART and LISTVIEW widgets on Donations', () => {
    const out = withReceivedRule([
      num(),
      { name: 'c', kind: 'CHART', chart: { board: 'donations', graphType: 'donut', x: 'Gift Size', xGroupBy: 'color', y: 'count' } },
      { name: 'l', kind: 'LISTVIEW', list: { board: 'donations', columns: ['Donor'] } },
    ]);
    for (const w of out) expect(received(w), w.name).toBe(1);
  });

  it('keeps a widget’s own rules and appends Received', () => {
    const own = { columnTitle: 'Thank You Sent', operator: 'is_empty' };
    const [w] = withReceivedRule([num({ filter: { board: 'donations', rules: [own] } })]);
    expect(w!.filter!.rules[0]).toEqual(own);
    expect(received(w!)).toBe(1);
  });

  it('skips a widget marked allStatuses, and widgets on other boards (Review Focus 7)', () => {
    const [spans, elsewhere] = withReceivedRule([
      num({ allStatuses: true }),
      { name: 'e', kind: 'NUMBER', number: { boards: ['events'], count: true } },
    ]);
    expect(received(spans!)).toBe(0);
    expect(received(elsewhere!)).toBe(0);
  });
});

describe('report-subscription views (docs/35 §3.6)', () => {
  // report-digests links its emails to these views by name (its config/*.json "view" values), so a
  // rename here must be made there too.
  const view = (board: string, name: string) => BOARD_SPECS[board]!.views!.find((x) => x.name === name);

  it('has every view the report-digests emails link to', () => {
    for (const [board, name] of [['donations', 'Needs a donor'], ['donations', 'By gift size'], ['donations', 'Gifts, last 7 days'],
      ['donations', 'Gifts, last 60 days'], ['people-live', 'Renewals this month and next']]) {
      expect(view(board!, name!), `${board} / ${name}`).toBeDefined();
    }
  });

  it('the renewals view spans this calendar month and next', () => {
    expect(view('people-live', 'Renewals this month and next')!.filter!.rules).toEqual(
      [{ columnTitle: 'Member Until', operator: 'any_of', compareValue: ['THIS_MONTH', 'ONE_MONTH_FROM_NOW'] }]);
  });
});

describe('Martha\'s reconciliation views', () => {
  const views = BOARD_SPECS['donations']!.views!.filter((v) => v.name.startsWith('Reconciliation: '));

  it('has the three views, each ungrouped (one footer total) and counting nothing but positive gifts', () => {
    expect(views.map((v) => v.name)).toEqual(
      ['Reconciliation: individual gifts', 'Reconciliation: matching gifts', 'Reconciliation: sponsorships']);
    for (const v of views) {
      expect(v.groupBy, v.name).toBeUndefined();
      expect(v.filter!.rules, v.name).toContainEqual({ columnTitle: 'Amount', operator: 'greater_than', compareValue: 0 });
    }
  });

  it('keeps Gift Size as a column where the view no longer groups by it', () => {
    for (const v of views.slice(0, 2)) expect(v.columns, v.name).toContain('Gift Size');
  });

  // Gift Type is a Status column (2026-11-20): a gift shows when it passes every Gift Type rule.
  const showsGiftType = (v: (typeof views)[number], giftType: string) =>
    v.filter!.rules.filter((r) => r.columnTitle === 'Gift Type').every((r) =>
      r.operator === 'any_of' ? r.labelValues!.includes(giftType)
        : r.operator === 'not_any_of' ? !r.labelValues!.includes(giftType) : true);

  it('the sponsorships view counts sponsorships but not in-kind gifts (svbc-monday-migration GL#114)', () => {
    expect(showsGiftType(views[2]!, 'Sponsorship')).toBe(true);
    expect(showsGiftType(views[2]!, 'In Kind Donation / Sponsorship')).toBe(false);
    expect(showsGiftType(views[2]!, 'Donation')).toBe(false);
  });

  it('the individual view leaves out every other revenue stream', () => {
    for (const t of ['Sponsorship', 'Matching Donation', 'In Kind Donation / Sponsorship', 'Grants', 'Contracts', 'Event Ticket']) {
      expect(showsGiftType(views[0]!, t), t).toBe(false);
    }
    for (const t of ['Donation', 'Membership', 'Donor Advised Fund']) expect(showsGiftType(views[0]!, t), t).toBe(true);
  });

  it('the matching view counts matching gifts only', () => {
    expect(showsGiftType(views[1]!, 'Matching Donation')).toBe(true);
    expect(showsGiftType(views[1]!, 'Donation')).toBe(false);
  });
});

describe('Donations Gift Type filters', () => {
  it('match Status labels, never text: Monday rejects a text operator on a Status column', () => {
    const rules = BOARD_SPECS['donations']!.views!.flatMap((v) => (v.filter?.rules ?? []).map((r) => ({ view: v.name, r })))
      .filter(({ r }) => r.columnTitle === 'Gift Type');
    expect(rules.length).toBeGreaterThan(0);
    for (const { view, r } of rules) {
      expect(['any_of', 'not_any_of'], view).toContain(r.operator);
      expect(r.labelValues?.length, view).toBeGreaterThan(0);
      expect(r.compareValue, view).toBeUndefined();
    }
  });
});

describe('Windfall wealth screening', () => {
  it('is described by no board or dashboard spec, so configure and load cannot recreate it on People', () => {
    const banned = /Windfall|Net Worth|Philanthropic|Job Title|LinkedIn|Wealth screening/;
    expect(JSON.stringify(BOARD_SPECS)).not.toMatch(banned);
    expect(JSON.stringify(DASHBOARD_SPECS)).not.toMatch(banned);
    expect(PLUMBING).not.toContain('Windfall ID');
  });
});

describe('pledges stay out of the gift views (2026-11-24)', () => {
  const view = (name: string) => BOARD_SPECS['donations']!.views!.find((v) => v.name === name)!;
  // A gift shows when it passes every Status rule the view has.
  const showsStatus = (name: string, status: string) =>
    (view(name).filter?.rules ?? []).filter((r) => r.columnTitle === 'Status').every((r) =>
      r.operator === 'any_of' ? r.labelValues!.includes(status)
        : r.operator === 'not_any_of' ? !r.labelValues!.includes(status) : false);

  it.each(['Recent gifts', 'Revenue by funding stream', 'Major gifts to thank', 'Reconciliation: sponsorships'])(
    '"%s" shows only Received gifts', (name) => {
      expect(showsStatus(name, 'Received')).toBe(true);
      for (const s of ['Pledged', 'Pending', 'Failed', 'Refunded']) expect(showsStatus(name, s), s).toBe(false);
    });

  it.each(['By gift size', 'By fiscal quarter', 'Matching gifts'])('"%s" leaves out only pledges', (name) => {
    expect(showsStatus(name, 'Pledged')).toBe(false);
    for (const s of ['Received', 'Pending', 'Failed']) expect(showsStatus(name, s), s).toBe(true);
  });

  it('keeps each view’s own filter', () => {
    expect(view('Major gifts to thank').filter!.rules).toContainEqual({ columnTitle: 'Thank You Sent', operator: 'is_empty' });
    expect(view('Matching gifts').filter!.rules).toContainEqual({ columnTitle: 'Gift Type', operator: 'any_of', labelValues: ['Matching Donation'] });
    expect(view('Reconciliation: sponsorships').filter!.rules).toContainEqual({ columnTitle: 'Amount', operator: 'greater_than', compareValue: 0 });
  });

  it('describes Pledged, and the load seeds it so those views resolve', () => {
    expect(BOARD_SPECS['donations']!.columnDescriptions!['Status']).toContain('Pledged');
    expect(DONATION_STATUS_LABELS).toContain('Pledged');
  });
});
