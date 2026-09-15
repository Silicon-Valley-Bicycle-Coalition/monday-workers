import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: {
      donations: 111,
      organizations: 222,
      people: 333,
      affiliations: 444,
      benevityUploads: 555,
    },
  },
  benevityImport: {
    minDonationDate: '2026-07-01',
    donationsColumns: {
      donor: 'donor_col',
      matchedBy: 'matched_by_col',
      amount: 'amount_col',
      date: 'date_col',
      disbursementDate: 'disbursement_date_col',
      fiscalYearEnding: 'fy_ending_col',
      status: 'status_col',
      giftType: 'gift_type_col',
      anonymousDonor: 'anonymous_col',
      transactionId: 'txn_id_col',
    },
    organizationsNameColumn: 'name',
    peopleColumns: {
      personalEmail: 'personal_email_col',
      householdEmail: 'household_email_col',
      employer: 'employer_col',
    },
    affiliationsColumns: {
      person: 'person_col',
      organization: 'organization_col',
      workEmail: 'work_email_col',
    },
    uploadsBoard: {
      fileColumn: 'file_col',
      worklistGroupId: 'review',
      worklistColumns: {
        reason: 'reason_col',
        name: 'name_col',
        email: 'email_col',
        company: 'company_col',
        amount: 'amount_col',
        date: 'date_col',
      },
    },
    organizationAliases: { 'Google, LLC': 'Google' },
    rawRowRetentionDays: 90,
    unresolvedRowRetentionDays: 365,
  },
};

describe('validateConfig', () => {
  it('accepts a fully-populated config', () => {
    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it('rejects a missing board id key', () => {
    const { organizations, ...rest } = validConfig.monday.boards;
    const bad = { ...validConfig, monday: { ...validConfig.monday, boards: rest } };
    expect(() => validateConfig(bad)).toThrow(/monday\.boards\.organizations/);
  });

  it('rejects a non-positive retention window', () => {
    const bad = {
      ...validConfig,
      benevityImport: { ...validConfig.benevityImport, rawRowRetentionDays: 0 },
    };
    expect(() => validateConfig(bad)).toThrow(/rawRowRetentionDays/);
  });

  it('rejects an organizationAliases value that is not a string', () => {
    const bad = {
      ...validConfig,
      benevityImport: { ...validConfig.benevityImport, organizationAliases: { Google: 42 } },
    };
    expect(() => validateConfig(bad)).toThrow(/organizationAliases/);
  });
});
