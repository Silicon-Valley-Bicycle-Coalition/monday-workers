import { describe, it, expect } from 'vitest';
import { buildGiftLedgerJson, buildGiftHistoryMarkdown, type GiftHistoryRow } from './giftHistory';

const row = (over: Partial<GiftHistoryRow>): GiftHistoryRow => ({
  mondayItemId: 'g1', donationBoardId: '100', amountCents: 5000, giftDateISO: '2020-01-15',
  fiscalYear: 2020, status: 'Received', giftType: 'Donation', archived: true, ...over,
});

describe('buildGiftLedgerJson', () => {
  it('emits compact tuples newest-first, empty string for unknown type', () => {
    const json = buildGiftLedgerJson([
      row({ mondayItemId: 'old', giftDateISO: '2015-06-01', giftType: null }),
      row({ mondayItemId: 'new', giftDateISO: '2026-03-01', amountCents: 12345 }),
    ]);
    expect(JSON.parse(json)).toEqual([
      ['new', '2026-03-01', 12345, 'Donation', 'Received'],
      ['old', '2015-06-01', 5000, '', 'Received'],
    ]);
  });
});

describe('buildGiftHistoryMarkdown', () => {
  it('renders a newest-first table with deep links and a maintenance note', () => {
    const md = buildGiftHistoryMarkdown([
      row({ mondayItemId: 'a', giftDateISO: '2015-06-01' }),
      row({ mondayItemId: 'b', giftDateISO: '2026-03-01', amountCents: 100000, giftType: 'Sponsorship' }),
    ], 'https://acme.monday.com');
    const lines = md.split('\n');
    expect(lines[0]).toBe('## Gift History');
    expect(lines[4]).toBe('| [2026-03-01](https://acme.monday.com/boards/100/pulses/b) | $1,000.00 | Sponsorship | Received |');
    expect(lines[5]).toContain('[2015-06-01]');
    expect(md).toContain('2 gifts. Maintained automatically');
  });

  it('degrades gracefully for undated gifts and missing board ids', () => {
    const md = buildGiftHistoryMarkdown([row({ giftDateISO: '', donationBoardId: null })], 'https://x');
    expect(md).toContain('| (undated) | $50.00 |');
    expect(md).not.toContain('](https://x');
  });
});
