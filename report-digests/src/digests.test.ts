import { describe, it, expect } from 'vitest';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';
import { buildDigest, MAX_ROWS } from './digests';
import { localTime } from './schedule';
import { FakeMonday, item } from '../test/fakeMonday';

const config = validateConfig(sandbox);
const monday8 = localTime(new Date('2026-10-26T15:00:00Z'), config.timeZone);
const gift = (id: string, amount: string, date: string, extra: Record<string, string> = {}) =>
  item(id, `Gift ${id}`, { amount, date, status: 'Received', gift_type: 'Donation', donor: `Donor ${id}`, stream: 'Individual', size: '$100–$499', ...extra },
    { donor: [`p${id}`] });

describe('unmatched-gifts', () => {
  it("uses the 'Needs a donor' view's rules and links that view", async () => {
    const monday = new FakeMonday([gift('1', '50', '2026-10-20', { donor: '' })]);
    const d = await buildDigest('unmatched-gifts', monday, config, monday8);
    expect(monday.queries[0]!.rules).toEqual([
      { column_id: 'donor', operator: 'is_empty', compare_value: [] },
      { column_id: 'anon', operator: 'is_empty', compare_value: [] },
    ]);
    expect(d.count).toBe(1);
    expect(d.viewUrl).toBe('https://bikesiliconvalley.monday.com/boards/18431577310/views/901');
  });
});

describe('renewals', () => {
  it('queries Member Until from the 1st of this month to the end of next, soonest first', async () => {
    const monday = new FakeMonday([
      item('2', 'Late', { until: '2026-11-20', ms: 'Active' }), item('1', 'Early', { until: '2026-10-05', ms: 'Lapsed' }),
    ]);
    const d = await buildDigest('renewals', monday, config, monday8);
    expect(monday.queries[0]!.rules).toEqual([
      { column_id: 'until', operator: 'greater_than_or_equals', compare_value: ['EXACT', '2026-10-01'] },
      { column_id: 'until', operator: 'lower_than_or_equal', compare_value: ['EXACT', '2026-11-30'] },
    ]);
    expect(d.sections[0]!.table!.rows.map((r) => r[1])).toEqual(['Early', 'Late']);
    // No view of that name on the fake board: the link falls back to the board.
    expect(d.viewUrl).toBe('https://bikesiliconvalley.monday.com/boards/18431577220');
  });
});

describe('recent-gifts-wealth', () => {
  it('splits at the floor, keeps only screened donors below it, and reads Windfall from the donor', async () => {
    const monday = new FakeMonday(
      [gift('1', '500', '2026-10-01'), gift('2', '50', '2026-10-02'), gift('3', '75', '2026-10-03'), gift('4', '900', '2026-10-04', { status: 'Failed' })],
      [
        { id: 'p1', name: 'A', boardId: '1', byTitle: new Map([['Net Worth', '2500000'], ['Job Title', 'CEO']]) },
        { id: 'p2', name: 'B', boardId: '1', byTitle: new Map([['Net Worth', '800000']]) },
        { id: 'p3', name: 'C', boardId: '1', byTitle: new Map() },
      ],
    );
    const d = await buildDigest('recent-gifts-wealth', monday, config, monday8);
    expect(monday.queries[0]!.rules).toEqual([
      { column_id: 'date', operator: 'greater_than_or_equals', compare_value: ['EXACT', '2026-08-27'] },
      { column_id: 'date', operator: 'lower_than_or_equal', compare_value: ['EXACT', '2026-10-26'] },
    ]);
    const [big, small] = d.sections;
    expect(big!.table!.rows).toHaveLength(1);
    expect(big!.table!.rows[0]!.slice(2, 7)).toEqual(['$500', 'Donation', '$2,500,000', '', 'CEO']);
    expect(small!.table!.rows.map((r) => r[1])).toEqual(['Donor 2']);
    expect(d.count).toBe(2);
    expect(d.subject).toContain('1 of $400+');
  });
});

describe('fiscal-year-by-size', () => {
  it('totals received gifts since July 1 by Gift Size, largest band first, with a total row', async () => {
    const monday = new FakeMonday([
      gift('1', '100', '2026-08-01'), gift('2', '200', '2026-09-01'),
      gift('3', '5000', '2026-09-02', { size: '$5,000+' }), gift('4', '10', '2026-09-03', { status: 'Pending' }),
    ]);
    const d = await buildDigest('fiscal-year-by-size', monday, config, monday8);
    expect(monday.queries[0]!.rules[0]!.compare_value).toEqual(['EXACT', '2026-07-01']);
    expect(d.sections[0]!.table!.rows).toEqual([['$5,000+', '1', '$5,000'], ['$100–$499', '2', '$300'], ['Total', '3', '$5,300']]);
    expect(d.subject).toBe('FY2027 to date: $5,300 from 3 gifts');
  });
});

describe('last-week', () => {
  it('lists the last 7 days newest first and caps the table', async () => {
    const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => gift(String(i), '10', `2026-10-${String(20 + (i % 6)).padStart(2, '0')}`));
    const monday = new FakeMonday(many);
    const d = await buildDigest('last-week', monday, config, monday8);
    expect(monday.queries[0]!.rules[0]!.compare_value).toEqual(['EXACT', '2026-10-19']);
    const t = d.sections[0]!.table!;
    expect(t.rows).toHaveLength(MAX_ROWS);
    expect(t.more).toBe(5);
    expect(t.rows[0]![0]).toBe('2026-10-25');
    expect(d.viewUrl).toContain('/views/902');
  });
});

describe('missing board or column', () => {
  it('fails loudly on a placeholder board and on a renamed column', async () => {
    const prod = validateConfig({ ...sandbox, boards: { donations: 0, people: 0 } });
    await expect(buildDigest('last-week', new FakeMonday(), prod, monday8)).rejects.toThrow('not visible');
    const broken = new FakeMonday([], [], [], [{ id: '18431577310', name: 'Donations', columns: [], views: [] }]);
    await expect(buildDigest('last-week', broken, config, monday8)).rejects.toThrow('has no column "Donor"');
  });
});
