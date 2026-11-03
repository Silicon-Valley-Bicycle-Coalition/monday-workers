import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

function validRaw(): Record<string, any> {
  return {
    dtd: { apiBase: 'https://doublethedonation.com/api/360matchpro/v1/', campaign: 'Test', pullOverlapMinutes: 120 },
    boards: { donations: 1, people: 2, organizations: 3, programSummary: 4 },
    donations: {
      amount: 'a', date: 'd', status: 's', giftType: 'gt', funraiseId: 'fi', salesforceId: 'si',
      benevityTransactionId: 'bt', anonymousDonor: 'ad', donor: 'dn', matchedBy: 'mb', matchStatus: 'ms',
      dtdStatusRaw: 'raw', matchCompany: 'mc', matchesGift: 'mg', matchPairing: 'mp', sentToDtd: 'std',
    },
    people: { email: 'e', firstName: 'f', lastName: 'l', phone: 'p', dtdCompanyId: 'ci', dtdCompany: 'cn', dtdLink: 'lk' },
    programSummary: {
      fiscalYear: 'fy', screened: 'sc', employerIdentified: 'ei', eligible: 'el', submitted: 'su', matchesPaid: 'mp',
      matchDollars: 'md', matchedGiftDollars: 'mgd', newMatchingCompanies: 'nmc', firstTimeMatchedDonors: 'ftd', asOf: 'ao',
    },
    push: {
      giftTypes: ['Donation', 'Event Ticket'], excludeGiftTypes: ['Matching Donation'], receivedStatus: 'Received',
      windowDays: 30, backfillFromISO: null, allowEmails: '*',
    },
    pairing: { windowMonths: 18, amountTolerance: 0.01 },
    statusLabels: { ':waiting-for-donor-action': 'Waiting for donor' },
  };
}

describe('validateConfig', () => {
  it('accepts a complete config', () => {
    expect(validateConfig(validRaw()).dtd.campaign).toBe('Test');
  });

  it('rejects REPLACE_WITH_COLUMN_ID in any column', () => {
    for (const group of ['donations', 'people', 'programSummary'] as const) {
      for (const key of Object.keys(validRaw()[group])) {
        const raw = validRaw();
        raw[group][key] = PLACEHOLDER;
        expect(() => validateConfig(raw), `${group}.${key}`).toThrow(/REPLACE_WITH_COLUMN_ID|column id/);
      }
    }
  });

  it('rejects push.allowEmails missing', () => {
    const raw = validRaw();
    delete raw.push.allowEmails;
    expect(() => validateConfig(raw)).toThrow(/allowEmails/);
  });

  it('accepts allowEmails "*" | string[] | null', () => {
    for (const allowEmails of ['*', ['staff@example.org'], null]) {
      const raw = validRaw();
      raw.push.allowEmails = allowEmails;
      expect(validateConfig(raw).push.allowEmails).toEqual(allowEmails);
    }
  });

  it('rejects an allowEmails string other than "*" and non-string entries', () => {
    for (const allowEmails of ['staff@example.org', [1], 5]) {
      const raw = validRaw();
      raw.push.allowEmails = allowEmails;
      expect(() => validateConfig(raw)).toThrow(/allowEmails/);
    }
  });

  it('statusLabels values must be strings', () => {
    const raw = validRaw();
    raw.statusLabels[':ineligible'] = 5;
    expect(() => validateConfig(raw)).toThrow(/statusLabels/);
  });

  it('rejects a missing board id', () => {
    const raw = validRaw();
    raw.boards.people = 'x';
    expect(() => validateConfig(raw)).toThrow(/boards\.people/);
  });
});
