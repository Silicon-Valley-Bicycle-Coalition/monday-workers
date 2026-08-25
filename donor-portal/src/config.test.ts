import { describe, it, expect } from 'vitest';
import { validateConfig, lettersEnabled, changeRequestsEnabled, cardEnabled, volunteerHistoryEnabled } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    donorsBoardId: null,
    donationsBoardId: null,
    organizationsBoardId: null,
    volunteersBoardId: 456,
    columns: {
      donorEmail: 'email_col',
      membershipStatus: 'status_col',
      membershipTier: 'tier_col',
      dollarDonated: 'donated_col',
      donationDonorLink: 'link_col',
      donationAmount: 'amount_col',
      donationDate: 'date_col',
      donationDescription: 'desc_col',
      discountOffered: 'offer_col',
      discountActive: 'active_col',
      donorAddress: 'text_addr',
      donorPhone: 'phone_1',
      membershipExpiry: 'expiry_col',
      preferredLanguage: 'lang_col',
      volunteerDonorLink: 'vol_link_col',
      volunteerHours: 'vol_hours_col',
      volunteerDate: 'vol_date_col',
      volunteerJob: 'vol_job_col',
      volunteerStatus: 'vol_status_col',
    },
  },
  email: { fromAddress: 'login@example.org', fromName: 'Test Portal' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
  taxLetter: {
    orgLegalName: 'Silicon Valley Bicycle Coalition',
    ein: '00-0000000',
    orgAddress: '123 Example St, San Jose, CA 95112',
    signatureName: 'Alex Example',
    signatureTitle: 'Executive Director',
    plainStatement: 'No goods or services were provided in exchange for these contributions.',
    benefitStatement: 'Your membership benefits have an estimated fair-market value of $0.',
    benefitTiers: ['Champion'],
  },
  changeRequests: {
    boardId: 123,
    columns: {
      donorLink: 'connect_1',
      field: 'text_1',
      oldValue: 'text_2',
      newValue: 'text_3',
      submittedAt: 'date_1',
    },
    dedupeWindowHours: 72,
    retentionDays: 180,
  },
  cardTokens: { retentionDays: 30 },
  volunteerHistory: { completedStatuses: ['Completed'] },
};

describe('validateConfig', () => {
  it('returns the config unchanged when valid', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('throws when a top-level key is missing', () => {
    const { email, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/email/);
  });

  it('throws when monday.columns is missing a column', () => {
    const { donorEmail, ...missingEmail } = validConfig.monday.columns;
    const broken = { ...validConfig, monday: { ...validConfig.monday, columns: missingEmail } };
    expect(() => validateConfig(broken)).toThrow(/donorEmail/);
  });

  it('throws when email is missing a key', () => {
    const { fromName, ...rest } = validConfig.email;
    const broken = { ...validConfig, email: rest };
    expect(() => validateConfig(broken)).toThrow(/fromName/);
  });

  it('throws when auth is missing a key', () => {
    const { portalBaseUrl, ...rest } = validConfig.auth;
    const broken = { ...validConfig, auth: rest };
    expect(() => validateConfig(broken)).toThrow(/portalBaseUrl/);
  });

  it('throws when rateLimit is missing a key', () => {
    const { emailMaxAttempts, ...rest } = validConfig.rateLimit;
    const broken = { ...validConfig, rateLimit: rest };
    expect(() => validateConfig(broken)).toThrow(/emailMaxAttempts/);
  });

  it('throws when monday is null', () => {
    expect(() => validateConfig({ ...validConfig, monday: null })).toThrow(/monday/);
  });

  it('throws when a column is still set to the placeholder value', () => {
    const broken = {
      ...validConfig,
      monday: {
        ...validConfig.monday,
        columns: { ...validConfig.monday.columns, donorEmail: 'REPLACE_WITH_COLUMN_ID' },
      },
    };
    expect(() => validateConfig(broken)).toThrow(/donorEmail/);
  });

  it('throws when monday.columns is missing membershipExpiry', () => {
    const { membershipExpiry, ...missingExpiry } = validConfig.monday.columns;
    const broken = { ...validConfig, monday: { ...validConfig.monday, columns: missingExpiry } };
    expect(() => validateConfig(broken)).toThrow(/membershipExpiry/);
  });

  it('accepts config with preferredLanguage present (even as the placeholder), same as membershipExpiry', () => {
    const cfg = {
      ...validConfig,
      monday: {
        ...validConfig.monday,
        columns: { ...validConfig.monday.columns, preferredLanguage: 'REPLACE_WITH_COLUMN_ID' },
      },
    };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects config missing preferredLanguage entirely', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.monday.columns as Record<string, unknown>).preferredLanguage;
    expect(() => validateConfig(cfg)).toThrow(/monday\.columns\.preferredLanguage/);
  });
});

// Helper: a fully-valid v2 config fragment for these tests. Reuse the file's existing
// valid-config fixture (validConfig) and spread these keys in — validConfig already carries
// matching real values, so this exists mainly for the tests below that mutate a single field.
const v2Sections = {
  taxLetter: {
    orgLegalName: 'Silicon Valley Bicycle Coalition',
    ein: '00-0000000',
    orgAddress: '123 Example St, San Jose, CA 95112',
    signatureName: 'Alex Example',
    signatureTitle: 'Executive Director',
    plainStatement: 'No goods or services were provided in exchange for these contributions.',
    benefitStatement: 'Your membership benefits have an estimated fair-market value of $0.',
    benefitTiers: ['Champion'],
  },
  changeRequests: {
    boardId: 123,
    columns: {
      donorLink: 'connect_1',
      field: 'text_1',
      oldValue: 'text_2',
      newValue: 'text_3',
      submittedAt: 'date_1',
    },
    dedupeWindowHours: 72,
    retentionDays: 180,
  },
  cardTokens: { retentionDays: 30 },
};

describe('v2 config sections', () => {
  it('rejects a config missing the taxLetter section', () => {
    const cfg = structuredClone(validConfig);
    Object.assign(cfg, v2Sections);
    delete (cfg as Record<string, unknown>).taxLetter;
    expect(() => validateConfig(cfg)).toThrow('taxLetter');
  });

  it('rejects a config missing changeRequests.dedupeWindowHours', () => {
    const cfg = structuredClone(validConfig);
    Object.assign(cfg, structuredClone(v2Sections));
    delete (cfg as { changeRequests: Record<string, unknown> }).changeRequests.dedupeWindowHours;
    expect(() => validateConfig(cfg)).toThrow('changeRequests.dedupeWindowHours');
  });

  it('rejects a config missing changeRequests.retentionDays', () => {
    const cfg = structuredClone(validConfig);
    Object.assign(cfg, structuredClone(v2Sections));
    delete (cfg as { changeRequests: Record<string, unknown> }).changeRequests.retentionDays;
    expect(() => validateConfig(cfg)).toThrow('changeRequests.retentionDays');
  });

  it('rejects changeRequests.retentionDays that is not a positive number', () => {
    const cfg = structuredClone(validConfig);
    Object.assign(cfg, structuredClone(v2Sections));
    (cfg as { changeRequests: { retentionDays: number } }).changeRequests.retentionDays = 0;
    expect(() => validateConfig(cfg)).toThrow(/retentionDays/);
  });

  it('rejects a config missing the cardTokens section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).cardTokens;
    expect(() => validateConfig(cfg)).toThrow('cardTokens');
  });

  it('rejects a config missing cardTokens.retentionDays', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { cardTokens: Record<string, unknown> }).cardTokens.retentionDays;
    expect(() => validateConfig(cfg)).toThrow('cardTokens.retentionDays');
  });

  it('rejects cardTokens.retentionDays that is not a positive number', () => {
    const cfg = structuredClone(validConfig);
    (cfg as { cardTokens: { retentionDays: number } }).cardTokens.retentionDays = 0;
    expect(() => validateConfig(cfg)).toThrow(/retentionDays/);
  });

  it('accepts REPLACE_AFTER_SIGNOFF letter language (gate, not error)', () => {
    const cfg = structuredClone(validConfig);
    Object.assign(cfg, structuredClone(v2Sections));
    (cfg as { taxLetter: { plainStatement: string } }).taxLetter.plainStatement = 'REPLACE_AFTER_SIGNOFF';
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('lettersEnabled', () => {
  it('is true when every taxLetter field is real', () => {
    const cfg = validateConfig(Object.assign(structuredClone(validConfig), structuredClone(v2Sections)));
    expect(lettersEnabled(cfg)).toBe(true);
  });

  it('is false while any taxLetter string is still REPLACE_AFTER_SIGNOFF', () => {
    const raw = Object.assign(structuredClone(validConfig), structuredClone(v2Sections));
    (raw as { taxLetter: { ein: string } }).taxLetter.ein = 'REPLACE_AFTER_SIGNOFF';
    expect(lettersEnabled(validateConfig(raw))).toBe(false);
  });
});

describe('changeRequestsEnabled', () => {
  it('is true when boardId is set and no column is a placeholder', () => {
    const cfg = validateConfig(Object.assign(structuredClone(validConfig), structuredClone(v2Sections)));
    expect(changeRequestsEnabled(cfg)).toBe(true);
  });

  it('is false when boardId is null', () => {
    const raw = Object.assign(structuredClone(validConfig), structuredClone(v2Sections));
    (raw as { changeRequests: { boardId: number | null } }).changeRequests.boardId = null;
    expect(changeRequestsEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while a Change Requests column id is a placeholder', () => {
    const raw = Object.assign(structuredClone(validConfig), structuredClone(v2Sections));
    (raw as { changeRequests: { columns: { field: string } } }).changeRequests.columns.field = 'REPLACE_WITH_COLUMN_ID';
    expect(changeRequestsEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while donorAddress/donorPhone Donors-board columns are placeholders', () => {
    const raw = Object.assign(structuredClone(validConfig), structuredClone(v2Sections));
    (raw as { monday: { columns: { donorAddress: string } } }).monday.columns.donorAddress = 'REPLACE_WITH_COLUMN_ID';
    expect(changeRequestsEnabled(validateConfig(raw))).toBe(false);
  });
});

describe('volunteerHistory config section', () => {
  it('rejects a config missing the volunteerHistory section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).volunteerHistory;
    expect(() => validateConfig(cfg)).toThrow('volunteerHistory');
  });

  it('rejects a config missing volunteerHistory.completedStatuses', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { volunteerHistory: Record<string, unknown> }).volunteerHistory.completedStatuses;
    expect(() => validateConfig(cfg)).toThrow('volunteerHistory.completedStatuses');
  });

  it('rejects completedStatuses that is not an array of strings', () => {
    const cfg = structuredClone(validConfig);
    (cfg as { volunteerHistory: { completedStatuses: unknown } }).volunteerHistory.completedStatuses = [1, 2];
    expect(() => validateConfig(cfg)).toThrow(/completedStatuses/);
  });

  it('accepts an empty completedStatuses array (meaning: include every status)', () => {
    const cfg = structuredClone(validConfig);
    cfg.volunteerHistory.completedStatuses = [];
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a config missing monday.volunteersBoardId entirely (undefined must not read as enabled)', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.monday as Record<string, unknown>).volunteersBoardId;
    expect(() => validateConfig(cfg)).toThrow(/volunteersBoardId/);
  });

  it('rejects a volunteersBoardId that is neither a number nor null', () => {
    const cfg = structuredClone(validConfig);
    (cfg.monday as { volunteersBoardId: unknown }).volunteersBoardId = '456';
    expect(() => validateConfig(cfg)).toThrow(/volunteersBoardId/);
  });

  it('rejects a config missing a volunteer column entirely', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.monday.columns as Record<string, unknown>).volunteerHours;
    expect(() => validateConfig(cfg)).toThrow(/monday\.columns\.volunteerHours/);
  });

  it('accepts volunteer columns left as placeholders (gate, not error)', () => {
    const cfg = structuredClone(validConfig);
    cfg.monday.columns.volunteerDonorLink = 'REPLACE_WITH_COLUMN_ID';
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('volunteerHistoryEnabled', () => {
  it('is true when volunteersBoardId is set and no volunteer column is a placeholder', () => {
    expect(volunteerHistoryEnabled(validateConfig(validConfig))).toBe(true);
  });

  it('is false when volunteersBoardId is null', () => {
    const raw = structuredClone(validConfig);
    (raw.monday as { volunteersBoardId: number | null }).volunteersBoardId = null;
    expect(volunteerHistoryEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while any volunteer column is still the placeholder', () => {
    const raw = structuredClone(validConfig);
    raw.monday.columns.volunteerStatus = 'REPLACE_WITH_COLUMN_ID';
    expect(volunteerHistoryEnabled(validateConfig(raw))).toBe(false);
  });
});

describe('cardEnabled', () => {
  it('is true when membershipExpiry is a real column id', () => {
    const cfg = validateConfig(validConfig);
    expect(cardEnabled(cfg)).toBe(true);
  });

  it('is false while membershipExpiry is still the placeholder', () => {
    const raw = structuredClone(validConfig);
    raw.monday.columns.membershipExpiry = 'REPLACE_WITH_COLUMN_ID';
    expect(cardEnabled(validateConfig(raw))).toBe(false);
  });
});
