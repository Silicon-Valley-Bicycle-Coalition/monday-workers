import { describe, it, expect } from 'vitest';
import { parseBenevityReport, type ParsedBlock } from './report';

// Structure matches a real SVBC export verified 2026-09-15 (see benevity-import/README.md,
// Input format) — all names/amounts below are synthetic.
function block(opts: {
  disbursementId?: string;
  periodEnding?: string;
  currency?: string;
  rows?: string[];
  grossTotal?: string;
} = {}): string {
  const {
    disbursementId = 'ABC123',
    periodEnding = 'Tue 16 Dec 2025 0:00:00',
    currency = 'USD',
    rows = [
      '"Acme, Inc.",Silicon Valley Bicycle Coalition,2025-12-06T01:40:55Z,Jordan,Rivera,jordan@acme.example,Not shared by donor,Not shared by donor,Not shared by donor,94043,,,TXN001,One Time,USD,,BlueSnap,User Donation,50.00,100.00,0.00,0.00,',
    ],
    grossTotal = '150.00',
  } = opts;
  return [
    'Donations Report,',
    '"#-------------------------------------------",',
    'Charity Name,SILICON VALLEY BICYCLE COALITION',
    'Charity ID,840-770338658',
    `Period Ending,${periodEnding}`,
    `Currency,${currency}`,
    'Payment Method,EFT',
    `Disbursement ID,${disbursementId}`,
    'Note,Rounding may be applied to some values in this report.',
    '"#-------------------------------------------",',
    '',
    'Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment',
    ...rows,
    `Totals,,,,,,,,,,,,,,,,,,${grossTotal},0.00,0.00,0.00`,
    `Total Donations (Gross),${grossTotal}`,
    'Check Fee,0.00',
    `Net Total Payment,${grossTotal}`,
    '',
  ].join('\n');
}

describe('parseBenevityReport', () => {
  it('parses a single-disbursement block', () => {
    // block() always yields exactly one block (one "Donations Report" line)
    const [result] = parseBenevityReport(block()) as [ParsedBlock];
    expect(result.headerError).toBeNull();
    expect(result.disbursementId).toBe('ABC123');
    expect(result.periodEnding).toBe('2025-12-16');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      company: 'Acme, Inc.',
      donorFirstName: 'Jordan',
      donorLastName: 'Rivera',
      email: 'jordan@acme.example',
      donationDate: '2025-12-06',
      transactionId: 'TXN001',
      currency: 'USD',
      totalDonationToBeAcknowledged: 50,
      matchAmount: 100,
    });
  });

  it('flags "Not shared by donor" through unchanged for the resolver to interpret', () => {
    const csv = block({
      rows: [
        '"Acme, Inc.",Project,2025-12-06T01:40:55Z,Not shared by donor,Not shared by donor,Not shared by donor,Not shared by donor,Not shared by donor,Not shared by donor,94043,,,TXN002,One Time,USD,,BlueSnap,User Donation,25.00,0.00,0.00,0.00,',
      ],
      grossTotal: '25.00',
    });
    // csv's rows fixture above has exactly one row
    const [result] = parseBenevityReport(csv) as [ParsedBlock];
    expect(result.rows[0]!.donorFirstName).toBe('Not shared by donor');
    expect(result.rows[0]!.email).toBe('Not shared by donor');
  });

  it('parses a row reported in a non-USD currency without rejecting it', () => {
    const csv = block({
      rows: [
        '"Acme, Inc.",Project,2025-12-06T01:40:55Z,Jordan,Rivera,jordan@acme.example,Not shared by donor,Not shared by donor,Not shared by donor,94043,,,TXN003,One Time,EUR,,BlueSnap,User Donation,120.00,240.00,0.00,0.00,',
      ],
      grossTotal: '360.00',
    });
    // csv's rows fixture above has exactly one row
    const [result] = parseBenevityReport(csv) as [ParsedBlock];
    expect(result.rows[0]!.currency).toBe('EUR');
  });

  it('flags a block whose row totals do not match its reported gross total', () => {
    const csv = block({ grossTotal: '999.00' });
    // block() always yields exactly one block
    const [result] = parseBenevityReport(csv) as [ParsedBlock];
    expect(result.sumMismatch).toBe(true);
  });

  it('does not flag a block whose row totals match its reported gross total', () => {
    // block() always yields exactly one block
    const [result] = parseBenevityReport(block()) as [ParsedBlock];
    expect(result.sumMismatch).toBe(false);
  });

  it('records a header error without throwing, for a block missing a required column', () => {
    const csv = block().replace('Transaction ID,', 'Txn Id Renamed,');
    // block() always yields exactly one block
    const [result] = parseBenevityReport(csv) as [ParsedBlock];
    expect(result.headerError).toMatch(/Transaction ID/);
    expect(result.rows).toEqual([]);
  });

  it('parses a file bundling two disbursements into two independent blocks', () => {
    const csv = block({ disbursementId: 'FIRST01' }) + block({ disbursementId: 'SECOND02' });
    const results = parseBenevityReport(csv);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.disbursementId)).toEqual(['FIRST01', 'SECOND02']);
  });

  it('a bad block in a bundle does not prevent the good block from parsing', () => {
    const bad = block({ disbursementId: 'BAD01' }).replace('Transaction ID,', 'Txn Id Renamed,');
    const good = block({ disbursementId: 'GOOD02' });
    const results = parseBenevityReport(bad + good);
    // bad + good always yields exactly 2 blocks (two "Donations Report" lines)
    expect(results[0]!.headerError).not.toBeNull();
    expect(results[1]!.headerError).toBeNull();
    expect(results[1]!.disbursementId).toBe('GOOD02');
  });

  it('throws if the file contains no "Donations Report" block at all', () => {
    expect(() => parseBenevityReport('not,a,benevity,file\n')).toThrow(/no "Donations Report" block/);
  });
});
