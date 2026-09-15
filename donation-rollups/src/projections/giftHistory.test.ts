import { describe, it, expect } from 'vitest';
import {
  buildGiftLedgerJson, buildGiftHistoryMarkdown, parseGiftLedgerJson,
  GIFT_LEDGER_ALERT_BYTES, GIFT_LEDGER_MAX_BYTES, GIFT_LEDGER_TRUNCATION_ID,
  type GiftHistoryRow,
} from './giftHistory';

const row = (over: Partial<GiftHistoryRow>): GiftHistoryRow => ({
  mondayItemId: 'g1', donationBoardId: '100', amountCents: 5000, giftDateISO: '2020-01-15',
  fiscalYear: 2020, status: 'Received', giftType: 'Donation', actingForItemId: null, archived: true, ...over,
});

// Enough rows to overflow any byte budget: each tuple serializes to ~50 bytes.
function manyRows(count: number): GiftHistoryRow[] {
  return Array.from({ length: count }, (_, i) =>
    row({
      mondayItemId: `18427756${String(i).padStart(6, '0')}`,
      giftDateISO: `${2000 + (i % 26)}-01-${String((i % 28) + 1).padStart(2, '0')}`,
    }));
}

describe('buildGiftLedgerJson', () => {
  it('emits compact tuples newest-first, empty string for unknown type', () => {
    const ledger = buildGiftLedgerJson([
      row({ mondayItemId: 'old', giftDateISO: '2015-06-01', giftType: null }),
      row({ mondayItemId: 'new', giftDateISO: '2026-03-01', amountCents: 12345 }),
    ]);
    expect(JSON.parse(ledger.json)).toEqual([
      ['new', '2026-03-01', 12345, 'Donation', 'Received'],
      ['old', '2015-06-01', 5000, '', 'Received'],
    ]);
    expect(ledger.truncated).toBe(false);
    expect(ledger.totalCount).toBe(2);
    expect(ledger.includedCount).toBe(2);
    expect(ledger.fullBytes).toBe(ledger.json.length); // all-ASCII fixture
  });

  it('past the alert threshold but under the write budget: full JSON, oversized bytes reported', () => {
    const rows = manyRows(1_000); // ~50KB — between 48KB alert and 60KB budget
    const ledger = buildGiftLedgerJson(rows);
    expect(ledger.fullBytes).toBeGreaterThan(GIFT_LEDGER_ALERT_BYTES);
    expect(ledger.fullBytes).toBeLessThanOrEqual(GIFT_LEDGER_MAX_BYTES);
    expect(ledger.truncated).toBe(false);
    expect(JSON.parse(ledger.json)).toHaveLength(1_000);
  });

  it('past the write budget: truncates to the most recent entries plus a marker, never a dead write', () => {
    const rows = manyRows(2_000); // ~100KB — would kill the Monday write untruncated
    const ledger = buildGiftLedgerJson(rows);
    expect(ledger.truncated).toBe(true);
    expect(ledger.fullBytes).toBeGreaterThan(GIFT_LEDGER_MAX_BYTES);
    expect(ledger.json.length).toBeLessThanOrEqual(GIFT_LEDGER_MAX_BYTES);

    const parsed = JSON.parse(ledger.json) as [string, string, number, string, string][];
    expect(ledger.includedCount).toBeGreaterThan(0);
    expect(ledger.includedCount).toBeLessThan(2_000);
    expect(parsed).toHaveLength(ledger.includedCount + 1); // + the marker entry

    // Newest entries survive; the marker sits last (the oldest position) and names the counts.
    const newest = [...rows].sort((a, b) => b.giftDateISO.localeCompare(a.giftDateISO))[0]!;
    expect(parsed[0]![0]).toBe(newest.mondayItemId);
    const marker = parsed.at(-1)!;
    expect(marker[0]).toBe(GIFT_LEDGER_TRUNCATION_ID);
    expect(marker[2]).toBe(0); // never pollutes a sum over the tuples
    expect(marker[4]).toContain(String(2_000));
  });
});

describe('parseGiftLedgerJson', () => {
  it('round-trips an untruncated projection', () => {
    const ledger = buildGiftLedgerJson([row({ mondayItemId: 'a' }), row({ mondayItemId: 'b', status: 'Pledged' })]);
    const parsed = parseGiftLedgerJson(ledger.json)!;
    expect(parsed.truncated).toBe(false);
    expect(parsed.entries).toEqual([
      { mondayItemId: 'a', amountCents: 5000, status: 'Received' },
      { mondayItemId: 'b', amountCents: 5000, status: 'Pledged' },
    ]);
  });

  it('flags the truncation marker and excludes it from the entries', () => {
    const ledger = buildGiftLedgerJson(manyRows(2_000));
    const parsed = parseGiftLedgerJson(ledger.json)!;
    expect(parsed.truncated).toBe(true);
    expect(parsed.entries).toHaveLength(ledger.includedCount);
    expect(parsed.entries.every((e) => e.mondayItemId !== GIFT_LEDGER_TRUNCATION_ID)).toBe(true);
  });

  it('returns null for anything that is not a well-formed projection', () => {
    expect(parseGiftLedgerJson('not json')).toBeNull();
    expect(parseGiftLedgerJson('{"a":1}')).toBeNull();
    expect(parseGiftLedgerJson('[["id","2020-01-01"]]')).toBeNull(); // tuple too short
    expect(parseGiftLedgerJson('[["id","2020-01-01","50","Donation","Received"]]')).toBeNull(); // cents not a number
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
