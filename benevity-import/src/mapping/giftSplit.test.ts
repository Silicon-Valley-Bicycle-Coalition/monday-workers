import { describe, it, expect } from 'vitest';
import { splitRowIntoGifts, type GiftSpec } from './giftSplit';
import type { ParsedRow } from '../parse/report';
import type { BenevityImportConfig } from '../types';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 1 } },
    benevityImport: {
      minDonationDate: '2026-07-01',
      donationsColumns: {
        donor: 'donor_col',
        matchedBy: 'matched_by_col',
        amount: 'amount_col',
        date: 'date_col',
        disbursementDate: 'disbursement_date_col',
        fiscalYearEnding: 'fy_col',
        status: 'status_col',
        giftType: 'gift_type_col',
        anonymousDonor: 'anon_col',
        transactionId: 'txn_col',
      },
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {} as never,
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    company: 'Acme, Inc.',
    donorFirstName: 'Jordan',
    donorLastName: 'Rivera',
    email: 'jordan@acme.example',
    donationDate: '2025-12-06',
    transactionId: 'TXN001',
    donationFrequency: 'One Time',
    currency: 'USD',
    totalDonationToBeAcknowledged: 50,
    matchAmount: 100,
    notes: '',
    ...overrides,
  };
}

describe('splitRowIntoGifts', () => {
  it('produces both an employee gift and a company match when both amounts are positive', () => {
    const gifts = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      fakeConfig()
    );
    expect(gifts).toHaveLength(2);
    expect(gifts.map((g) => g.transactionId)).toEqual(['TXN001', 'TXN001-match']);
  });

  it('produces only the employee gift when there is no match amount', () => {
    const gifts = splitRowIntoGifts(
      { row: fakeRow({ matchAmount: 0 }), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      fakeConfig()
    );
    expect(gifts).toHaveLength(1);
    expect(gifts[0]!.transactionId).toBe('TXN001'); // guarded by toHaveLength(1) above
  });

  it('produces only the company match when there is no employee amount', () => {
    const gifts = splitRowIntoGifts(
      {
        row: fakeRow({ totalDonationToBeAcknowledged: 0 }),
        disbursementPeriodEnding: '2025-12-16',
        organizationItemId: '99',
        personItemId: '5',
      },
      fakeConfig()
    );
    expect(gifts).toHaveLength(1);
    expect(gifts[0]!.transactionId).toBe('TXN001-match'); // guarded by toHaveLength(1) above
  });

  it('sets exact Gift Type and Status labels, and Matched By only on the match gift', () => {
    const config = fakeConfig();
    // fakeRow() defaults both amounts positive, so both the employee and match gift are produced
    // (see "produces both an employee gift and a company match" above)
    const [employeeGift, matchGift] = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      config
    ) as [GiftSpec, GiftSpec];
    expect(employeeGift.columnValues[config.benevityImport.donationsColumns.giftType]).toEqual({ label: 'Donation' });
    expect(employeeGift.columnValues[config.benevityImport.donationsColumns.status]).toEqual({ label: 'Received' });
    expect(employeeGift.columnValues[config.benevityImport.donationsColumns.matchedBy]).toBeUndefined();
    expect(matchGift.columnValues[config.benevityImport.donationsColumns.giftType]).toEqual({ label: 'Matching Donation' });
    expect(matchGift.columnValues[config.benevityImport.donationsColumns.matchedBy]).toEqual({ item_ids: [99] });
  });

  it('writes the disbursement Period Ending separately from the row Donation Date', () => {
    const config = fakeConfig();
    // fakeRow() defaults both amounts positive, so the employee gift is always produced first
    const [gift] = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: '5' },
      config
    ) as [GiftSpec, ...GiftSpec[]];
    expect(gift.columnValues[config.benevityImport.donationsColumns.date]).toEqual({ date: '2025-12-06' });
    expect(gift.columnValues[config.benevityImport.donationsColumns.disbursementDate]).toEqual({ date: '2025-12-16' });
  });

  it('checks Anonymous Donor and omits Donor when no person is resolved', () => {
    const config = fakeConfig();
    // fakeRow() defaults both amounts positive, so the employee gift is always produced first
    const [gift] = splitRowIntoGifts(
      { row: fakeRow(), disbursementPeriodEnding: '2025-12-16', organizationItemId: '99', personItemId: null },
      config
    ) as [GiftSpec, ...GiftSpec[]];
    expect(gift.columnValues[config.benevityImport.donationsColumns.anonymousDonor]).toEqual({ checked: 'true' });
    expect(gift.columnValues[config.benevityImport.donationsColumns.donor]).toBeUndefined();
    expect(gift.itemName).toContain('Anonymous');
  });

  it('computes Fiscal Year Ending from the Donation Date', () => {
    const config = fakeConfig();
    // fakeRow() defaults both amounts positive, so the employee gift is always produced first
    const [gift] = splitRowIntoGifts(
      {
        row: fakeRow({ donationDate: '2026-08-01' }),
        disbursementPeriodEnding: '2026-08-15',
        organizationItemId: '99',
        personItemId: '5',
      },
      config
    ) as [GiftSpec, ...GiftSpec[]];
    expect(gift.columnValues[config.benevityImport.donationsColumns.fiscalYearEnding]).toEqual({ date: '2027-06-30' });
  });
});
