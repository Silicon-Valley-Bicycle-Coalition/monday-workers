import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import { rawOutreach } from '../test/outreach';

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

function validRaw(): Record<string, any> {
  return {
    dtd: { apiBase: 'https://doublethedonation.com/api/360matchpro/v1/', campaign: 'Test', publicKey: 'test-public-key', pullOverlapMinutes: 120 },
    boards: { donations: 1, people: 2, organizations: 3, programSummary: 4 },
    donations: {
      amount: 'a', date: 'd', status: 's', giftType: 'gt', funraiseId: 'fi', salesforceId: 'si',
      benevityTransactionId: 'bt', anonymousDonor: 'ad', donor: 'dn', matchedBy: 'mb', matchStatus: 'ms',
      dtdStatusRaw: 'raw', matchCompany: 'mc', matchesGift: 'mg', matchPairing: 'mp', sentToDtd: 'std',
    },
    people: { email: 'e', householdEmail: 'he', firstName: 'fn', lastName: 'ln', phone: 'p', dtdCompanyId: 'ci', dtdCompany: 'cn', dtdLink: 'lk' },
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

  it('requires the People name columns', () => {
    const raw = validRaw();
    delete raw.people.firstName;
    expect(() => validateConfig(raw)).toThrow(/firstName/);
  });

  it('requires dtd.publicKey', () => {
    const raw = validRaw();
    delete raw.dtd.publicKey;
    expect(() => validateConfig(raw)).toThrow(/dtd\.publicKey/);
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

describe('outreach', () => {
  const withOutreach = (change: (o: Record<string, any>) => void = () => {}) => {
    const raw = validRaw();
    raw.outreach = rawOutreach();
    change(raw.outreach);
    return raw;
  };

  it('absent or null is null: the post-gift email is off', () => {
    expect(validateConfig(validRaw()).outreach).toBeNull();
    expect(validateConfig({ ...validRaw(), outreach: null }).outreach).toBeNull();
  });

  it('accepts a complete block', () => {
    expect(validateConfig(withOutreach()).outreach).toEqual(rawOutreach());
  });

  it('accepts null employerFormUrl, requestUrl and deadlineNote', () => {
    const cfg = validateConfig(withOutreach((o) => { o.employerFormUrl = null; })).outreach!;
    expect(cfg.employerFormUrl).toBeNull();
    expect(cfg.matchingEmployers[1]).toMatchObject({ requestUrl: null, deadlineNote: null });
  });

  it.each(['wordingApprovedOn', 'ein', 'fromAddress', 'fromName', 'replyTo', 'postalAddress', 'logoUrl', 'employerFormUrl'])('rejects %s awaiting sign-off', (key) => {
    expect(() => validateConfig(withOutreach((o) => { o[key] = 'REPLACE_AFTER_SIGNOFF'; }))).toThrow(new RegExp(`outreach\\.${key}`));
  });

  it('rejects sign-off placeholders inside an employer', () => {
    for (const key of ['name', 'platform', 'requestUrl', 'deadlineNote']) {
      expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[0][key] = 'REPLACE_AFTER_SIGNOFF'; })), key).toThrow(/REPLACE_AFTER_SIGNOFF/);
    }
    expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[0].aliases = ['REPLACE_AFTER_SIGNOFF']; }))).toThrow(/REPLACE_AFTER_SIGNOFF/);
  });

  it('rejects an unfilled column id', () => {
    for (const [group, keys] of Object.entries({
      donations: ['matchPromptSent'], people: ['employerName', 'doNotSolicit'],
      programSummary: ['prompted', 'promptedMatched', 'promptedMatchDollars'],
    })) {
      for (const key of keys) {
        expect(() => validateConfig(withOutreach((o) => { o[group][key] = PLACEHOLDER; })), `${group}.${key}`).toThrow(/REPLACE_WITH_COLUMN_ID/);
      }
    }
  });

  it('rejects an unknown mode and an unknown steps template', () => {
    expect(() => validateConfig(withOutreach((o) => { o.mode = 'sms'; }))).toThrow(/outreach\.mode/);
    expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[0].steps = 'carrier-pigeon'; }))).toThrow(/steps/);
  });

  it('rejects an approval date that is not a date', () => {
    for (const value of ['soon', '2026-13-45', '2026-02-30']) {
      expect(() => validateConfig(withOutreach((o) => { o.wordingApprovedOn = value; })), value).toThrow(/wordingApprovedOn/);
    }
  });

  it('takes https links only', () => {
    expect(() => validateConfig(withOutreach((o) => { o.employerFormUrl = 'http://member.example.org/'; }))).toThrow(/employerFormUrl/);
    expect(() => validateConfig(withOutreach((o) => { o.logoUrl = 'http://member.example.org/logo.png'; }))).toThrow(/logoUrl/);
    expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[0].requestUrl = 'javascript:alert(1)'; }))).toThrow(/requestUrl/);
  });

  it('rejects two employers that share a normalised name or alias', () => {
    expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[1].name = 'GOOGLE, LLC'; }))).toThrow(/Google|GOOGLE/);
    expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[1].aliases = ['alphabet inc']; }))).toThrow(/alphabet/i);
  });

  it('allows one employer to list spellings that normalise to its own name', () => {
    expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[0].aliases = ['Google LLC', 'Google, Inc.']; }))).not.toThrow();
  });

  it('rejects a name or alias that normalises to nothing', () => {
    expect(() => validateConfig(withOutreach((o) => { o.matchingEmployers[0].aliases = ['Inc.']; }))).toThrow(/Inc\./);
  });

  it('rejects a zero or negative delay, cooldown or attempt limit', () => {
    for (const key of ['delayDays', 'donorCooldownDays', 'maxAttempts']) {
      expect(() => validateConfig(withOutreach((o) => { o[key] = 0; })), key).toThrow(new RegExp(key));
    }
  });
});
