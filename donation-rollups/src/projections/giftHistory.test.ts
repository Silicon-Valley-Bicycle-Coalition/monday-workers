import { describe, it, expect } from 'vitest';
import {
  buildGiftLedgerJson, buildGiftHistoryMarkdown, parseGiftLedgerJson,
  GIFT_LEDGER_ALERT_BYTES, GIFT_LEDGER_MAX_BYTES, GIFT_LEDGER_TRUNCATION_ID,
  type GiftHistoryRow,
} from './giftHistory';

const row = (over: Partial<GiftHistoryRow>): GiftHistoryRow => ({
  mondayItemId: 'g1', donationBoardId: '100', amountCents: 5000, giftDateISO: '2020-01-15',
  fiscalYear: 2020, status: 'Received', giftType: 'Donation', actingForItemId: null, archived: true,
  sponsorshipEvent: null, inKindValueCents: null, ...over,
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
      ['new', '2026-03-01', 12345, 'Donation', 'Received', ''],
      ['old', '2015-06-01', 5000, '', 'Received', ''],
    ]);
    expect(ledger.truncated).toBe(false);
    expect(ledger.totalCount).toBe(2);
    expect(ledger.includedCount).toBe(2);
    expect(ledger.fullBytes).toBe(ledger.json.length); // all-ASCII fixture
  });

  it('past the alert threshold but under the write budget: full JSON, oversized bytes reported', () => {
    const rows = manyRows(900); // ~56KB with the acting-for element — between 48KB alert and 60KB budget
    const ledger = buildGiftLedgerJson(rows);
    expect(ledger.fullBytes).toBeGreaterThan(GIFT_LEDGER_ALERT_BYTES);
    expect(ledger.fullBytes).toBeLessThanOrEqual(GIFT_LEDGER_MAX_BYTES);
    expect(ledger.truncated).toBe(false);
    expect(JSON.parse(ledger.json)).toHaveLength(900);
  });

  it('past the write budget: truncates to the most recent entries plus a marker, never a dead write', () => {
    const rows = manyRows(2_000); // ~100KB — would kill the Monday write untruncated
    const ledger = buildGiftLedgerJson(rows);
    expect(ledger.truncated).toBe(true);
    expect(ledger.fullBytes).toBeGreaterThan(GIFT_LEDGER_MAX_BYTES);
    expect(ledger.json.length).toBeLessThanOrEqual(GIFT_LEDGER_MAX_BYTES);

    const parsed = JSON.parse(ledger.json) as [string, string, number, string, string, string][];
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

  it('tuples carry the acting-for affiliation id as a sixth element ("" when personal)', () => {
    const rows = [
      { mondayItemId: 'g1', donationBoardId: '1', amountCents: 5000, giftDateISO: '2020-01-15', fiscalYear: 2020, status: 'Received', giftType: 'Donation', archived: false, actingForItemId: null, sponsorshipEvent: null, inKindValueCents: null },
      { mondayItemId: 'g2', donationBoardId: '1', amountCents: 50000, giftDateISO: '2024-02-02', fiscalYear: 2024, status: 'Received', giftType: 'Sponsorship', archived: false, actingForItemId: 'af-1', sponsorshipEvent: null, inKindValueCents: null },
    ];
    expect(JSON.parse(buildGiftLedgerJson(rows).json)).toEqual([
      ['g2', '2024-02-02', 50000, 'Sponsorship', 'Received', 'af-1'],
      ['g1', '2020-01-15', 5000, 'Donation', 'Received', ''],
    ]);
    expect(parseGiftLedgerJson(buildGiftLedgerJson(rows).json)!.entries).toHaveLength(2);
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

  it('gains a "Driven for organizations" section only when there is driven giving', () => {
    const md = buildGiftHistoryMarkdown([], 'https://acme.monday.com', [{ affiliationName: 'Uma @ Beta Org', cents: 50000, count: 1 }]);
    expect(md).toContain('## Driven for organizations');
    expect(md).toContain('| Uma @ Beta Org | $500.00 | 1 |');
    expect(buildGiftHistoryMarkdown([], 'https://acme.monday.com')).not.toContain('Driven for');
  });

  it('escapes pipes in affiliation names to protect the markdown table', () => {
    const md = buildGiftHistoryMarkdown([], 'https://acme.monday.com', [{ affiliationName: 'Acme | Beta', cents: 50000, count: 1 }]);
    expect(md).toContain('| Acme \\| Beta | $500.00 | 1 |');
  });

  // Review finding 7: a loop-local `cell` shadowed the module-level cell() escaper, so the
  // gift table's Type/Status cells rendered unescaped while the driven table's names didn't.
  it('escapes pipes in the gift Type and Status cells too (finding 7)', () => {
    const md = buildGiftHistoryMarkdown([
      row({ mondayItemId: 'a', giftDateISO: '2020-01-01', giftType: 'A|B', status: 'C|D' }),
    ], 'https://acme.monday.com');
    expect(md).toContain('A\\|B');
    expect(md).toContain('C\\|D');
    expect(md).not.toContain('A|B');
    expect(md).not.toContain('C|D');
  });
});
