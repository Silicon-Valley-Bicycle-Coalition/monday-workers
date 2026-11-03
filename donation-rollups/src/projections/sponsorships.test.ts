import { describe, it, expect } from 'vitest';
import { buildSponsorshipsMarkdown } from './sponsorships';
import type { GiftHistoryRow } from './giftHistory';
import type { SponsorshipsConfig, FiscalYearConfig } from '../types';

const cfg: SponsorshipsConfig = {
  organizationsBoardId: 1, giftTypes: ['Sponsorship'], inKindGiftTypes: ['In-Kind Sponsorship'],
  yearBasis: 'calendar', windowYears: 7, pipelineBoards: {},
};
const fy: FiscalYearConfig = { startMonth: 7, timeZone: 'America/Los_Angeles' };
const URL = 'https://svbc.monday.com';
const row = (over: Partial<GiftHistoryRow>): GiftHistoryRow => ({
  mondayItemId: 'g1', donationBoardId: '100', amountCents: 500000, giftDateISO: '2026-04-12',
  fiscalYear: 2026, status: 'Received', giftType: 'Sponsorship', actingForItemId: null, archived: false,
  sponsorshipEvent: '2026 BTWD', inKindValueCents: null, ...over,
});
const build = (rows: GiftHistoryRow[], c = cfg, today = '2026-11-02') =>
  buildSponsorshipsMarkdown(rows, c, 'Received', fy, URL, today);

describe('buildSponsorshipsMarkdown', () => {
  it('renders the exact layout above for one cash and one in-kind gift', () => {
    const md = build([
      row({ mondayItemId: 'a' }),
      row({ mondayItemId: 'b', giftDateISO: '2026-02-01', giftType: 'In-Kind Sponsorship', amountCents: 0, inKindValueCents: 120000 }),
    ]);
    expect(md).toBe([
      '## Sponsorships',
      '',
      '| Year | Date | Event | Amount |',
      '| --- | --- | --- | --- |',
      '| 2026 | [2026-04-12](https://svbc.monday.com/boards/100/pulses/a) | 2026 BTWD | $5,000.00 |',
      '| 2026 | [2026-02-01](https://svbc.monday.com/boards/100/pulses/b) | 2026 BTWD | $1,200.00 (in-kind) |',
      '| **2026 total** | | | **$5,000.00 cash · $1,200.00 in-kind** |',
      '| **Total, 2020–2026** | | | **$5,000.00 cash · $1,200.00 in-kind** |',
      '',
      '_Paid and in-kind sponsorships, last 7 calendar years. Maintained automatically by donation-rollups — edits here are overwritten._',
    ].join('\n'));
  });

  it('in-kind uses inKindValueCents, falling back to amountCents when null or 0', () => {
    const k = 'In-Kind Sponsorship';
    const md = build([
      row({ mondayItemId: 'a', giftType: k, amountCents: 111100, inKindValueCents: null }),
      row({ mondayItemId: 'b', giftType: k, amountCents: 222200, inKindValueCents: 0 }),
      row({ mondayItemId: 'c', giftType: k, amountCents: 1, inKindValueCents: 333300 }),
    ])!;
    expect(md).toContain('$1,111.00 (in-kind)');
    expect(md).toContain('$2,222.00 (in-kind)');
    expect(md).toContain('$3,333.00 (in-kind)');
    expect(md).toContain('**$6,666.00 in-kind**');
  });

  it('excludes Pending, Failed, Received (Historical) and other gift types', () => {
    const md = build([
      row({ mondayItemId: 'ok' }),
      row({ mondayItemId: 'p', status: 'Pending' }),
      row({ mondayItemId: 'f', status: 'Failed' }),
      row({ mondayItemId: 'h', status: 'Received (Historical)' }),
      row({ mondayItemId: 'd', giftType: 'Donation' }),
      row({ mondayItemId: 'n', giftType: null }),
    ])!;
    expect(md).toContain('pulses/ok)');
    for (const id of ['p', 'f', 'h', 'd', 'n']) expect(md).not.toContain(`pulses/${id})`);
  });

  it('excludes gifts older than the window and keeps the current partial year', () => {
    const md = build([
      row({ mondayItemId: 'old', giftDateISO: '2019-12-31' }),
      row({ mondayItemId: 'in', giftDateISO: '2020-01-01' }),
    ])!;
    expect(md).toContain('pulses/in)');
    expect(md).not.toContain('pulses/old)');
    expect(md).toContain('**Total, 2020–2026**');
  });

  it('fiscal basis labels FY26 for 2025-07-01..2026-06-30', () => {
    const f = { ...cfg, yearBasis: 'fiscal' as const };
    const md = build([
      row({ mondayItemId: 'a', giftDateISO: '2025-07-01' }),
      row({ mondayItemId: 'b', giftDateISO: '2026-06-30' }),
      row({ mondayItemId: 'c', giftDateISO: '2025-06-30' }),
    ], f, '2026-11-02')!;
    expect(md).toContain('| FY26 | [2025-07-01]');
    expect(md).toContain('| FY26 | [2026-06-30]');
    expect(md).toContain('| FY25 | [2025-06-30]');
    expect(md).toContain('**FY26 total**');
    expect(md).toContain('**Total, FY21–FY27**'); // 2026-11-02 is in FY27
    expect(md).toContain('last 7 fiscal years');
  });

  it('returns null when nothing qualifies', () => {
    expect(build([])).toBeNull();
    expect(build([row({ status: 'Pending' })])).toBeNull();
  });

  it('undated gift is excluded', () => {
    expect(build([row({ giftDateISO: '' })])).toBeNull();
  });

  it('escapes | and newlines in event text', () => {
    expect(build([row({ sponsorshipEvent: 'A|B\nC' })])).toContain('| A\\|B C |');
  });

  it('blank event renders —', () => {
    expect(build([row({ sponsorshipEvent: null })])).toContain('| — |');
    expect(build([row({ sponsorshipEvent: '  ' })])).toContain('| — |');
  });

  it('renders bare date without a board, newest gift first', () => {
    const md = build([
      row({ mondayItemId: 'a', giftDateISO: '2026-01-01', donationBoardId: null }),
      row({ mondayItemId: 'b', giftDateISO: '2026-03-01', donationBoardId: null }),
    ])!;
    expect(md.indexOf('2026-03-01')).toBeLessThan(md.indexOf('2026-01-01'));
    expect(md).toContain('| 2026 | 2026-03-01 |');
  });
});
