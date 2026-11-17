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
    minDisbursementDate: '2026-07-01',
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
      status: 'aff_status_col',
    },
    affiliationsCurrentLabel: 'Current',
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

  it('requires minDisbursementDate as a plain YYYY-MM-DD date (it is compared as a string)', () => {
    const withDate = (minDisbursementDate: unknown) => ({
      ...validConfig,
      benevityImport: { ...validConfig.benevityImport, minDisbursementDate },
    });
    expect(() => validateConfig(withDate('2026-10-09'))).not.toThrow();
    for (const bad of ['10/09/2026', '2026-10-09T00:00:00Z', '2026-13-45', '', undefined]) {
      expect(() => validateConfig(withDate(bad)), String(bad)).toThrow(/minDisbursementDate/);
    }
  });

  it('rejects the pre-#40 minDonationDate key instead of silently ignoring it', () => {
    const stale = {
      ...validConfig,
      benevityImport: { ...validConfig.benevityImport, minDonationDate: '2026-10-09' },
    };
    expect(() => validateConfig(stale)).toThrow(/minDonationDate.*minDisbursementDate/);
  });

  it('requires the Affiliations status column and the Current label (#124)', () => {
    const { status, ...noStatus } = validConfig.benevityImport.affiliationsColumns;
    expect(() => validateConfig({
      ...validConfig, benevityImport: { ...validConfig.benevityImport, affiliationsColumns: noStatus },
    })).toThrow(/affiliationsColumns\.status/);
    expect(() => validateConfig({
      ...validConfig, benevityImport: { ...validConfig.benevityImport, affiliationsCurrentLabel: '' },
    })).toThrow(/affiliationsCurrentLabel/);
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

  it('accepts worklistKeyColumn as a column id, null, or absent, and rejects an empty string', () => {
    const withKey = (worklistKeyColumn: unknown) => ({
      ...validConfig,
      benevityImport: {
        ...validConfig.benevityImport,
        uploadsBoard: { ...validConfig.benevityImport.uploadsBoard, worklistKeyColumn },
      },
    });
    expect(() => validateConfig(withKey('key_col'))).not.toThrow();
    expect(() => validateConfig(withKey(null))).not.toThrow();
    expect(() => validateConfig(withKey(''))).toThrow(/worklistKeyColumn/);
    expect(() => validateConfig(withKey(7))).toThrow(/worklistKeyColumn/);
  });

  it('accepts a retry column with four distinct labels, or null, and rejects a partial one', () => {
    const withRetry = (retry: unknown) => ({
      ...validConfig,
      benevityImport: {
        ...validConfig.benevityImport,
        uploadsBoard: { ...validConfig.benevityImport.uploadsBoard, retry },
      },
    });
    const labels = { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' };
    expect(() => validateConfig(withRetry({ column: 'retry_col', labels }))).not.toThrow();
    expect(() => validateConfig(withRetry(null))).not.toThrow();
    expect(() => validateConfig(withRetry({ column: '', labels }))).toThrow(/retry\.column/);
    expect(() => validateConfig(withRetry({ column: 'c', labels: { ...labels, done: '' } }))).toThrow(/retry\.labels\.done/);
    expect(() => validateConfig(withRetry({ column: 'c', labels: { ...labels, done: 'Retry' } }))).toThrow(/distinct/);
  });
});
