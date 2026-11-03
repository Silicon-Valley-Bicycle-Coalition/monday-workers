import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  lettersEnabled,
  changeRequestsEnabled,
  cardEnabled,
  funraiseLinks,
  pledgesEnabled,
  matchingGiftsSearchEnabled,
  signedOffEin,
  configuredPrefFields,
  volunteerHistoryEnabled,
  donationHistoryEnabled,
  eventsEnabled,
  letterCronConfigured,
} from './config';

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
      donationStatus: 'donation_status_col',
      discountOffered: 'offer_col',
      discountActive: 'active_col',
      donorAddress: 'text_addr',
      donorPhone: 'phone_1',
      membershipExpiry: 'expiry_col',
      preferredLanguage: 'lang_col',
      donorEmailOptOut: 'check_email_opt',
      donorSmsOptOut: 'check_sms_opt',
      donorDoNotMail: 'check_no_mail',
      volunteerDonorLink: 'vol_link_col',
      volunteerHours: 'vol_hours_col',
      volunteerDate: 'vol_date_col',
      volunteerJob: 'vol_job_col',
      volunteerStatus: 'vol_status_col',
    },
  },
  email: { fromAddress: 'login@example.org', fromName: 'Test Portal', logoUrl: 'https://example.org/email/logo.png' },
  auth: { magicLinkTtlMinutes: 15, letterLinkTtlHours: 168, sessionTtlHours: 24, portalBaseUrl: 'https://example.org' },
  rateLimit: { emailCooldownSeconds: 60, emailWindowSeconds: 900, emailMaxAttempts: 5, emailDailyMax: 10, attemptRetentionHours: 24 },
  taxLetter: {
    orgLegalName: 'Silicon Valley Bicycle Coalition',
    ein: '00-0000000',
    officeAddress: '123 Example St, San Jose, CA 95112',
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
  donations: {
    countableStatuses: ['Received', 'Received (Historical)'],
    historyStartISO: '2026-01-01',
    historyVisibleFromISO: '2027-01-01',
  },
  eventRegistrations: {
    boardId: 456,
    columns: {
      attendeeLink: 'connect_2',
      eventLink: 'connect_3',
      attended: 'check_1',
    },
    eventDateColumnId: 'date_2',
  },
  funraise: {
    manageRecurringUrl: 'https://example.funraise.org/account',
    renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
  },
  getInvolved: {
    links: [
      { category: 'civic', label: 'Example BPAC', url: 'https://example.legistar.com/Calendar.aspx', calendarUrl: 'https://example.org/bpac.ics' },
      { category: 'volunteer', url: 'https://example.org/volunteer' },
    ],
  },
  pledges: {
    boardId: 456,
    columns: {
      donorLink: 'connect_2',
      pledgedAmount: 'numbers_1',
      fulfilledAmount: 'numbers_2',
      status: 'status_2',
      dueDate: 'date_2',
    },
  },
  matchingGifts: { doubleTheDonationPublicKey: 'dtd-public-key' },
  impact: {
    statementsByYear: {
      '2026': { en: ['Taught bike safety to 4,200 students'], es: ['Enseñamos seguridad ciclista a 4,200 estudiantes'] },
    },
  },
  letterCron: {
    boardId: 456,
    columns: {
      autoSend: 'checkbox_1',
      startDate: 'date_2',
      bodyTemplate: 'long_text_1',
      bodyTemplatesByLocale: { es: 'long_text_es' },
    },
    settingsItemName: 'Letter emails',
    maxTriggersPerRun: 200,
  },
};

describe('validateConfig getInvolved', () => {
  const withLinks = (links: unknown) => ({ ...validConfig, getInvolved: { links } });

  it('accepts an empty list (section omitted)', () => {
    expect(() => validateConfig(withLinks([]))).not.toThrow();
  });

  it('throws when getInvolved is missing', () => {
    const { getInvolved: _omit, ...rest } = validConfig;
    expect(() => validateConfig(rest)).toThrow('getInvolved');
  });

  it('throws when links is not a list', () => {
    expect(() => validateConfig(withLinks({}))).toThrow('"getInvolved.links" must be a list');
  });

  it('rejects an unknown category', () => {
    expect(() => validateConfig(withLinks([{ category: 'parks', label: 'x', url: 'https://x.org' }]))).toThrow('getInvolved.links[0].category');
  });

  it('rejects a non-https url or calendarUrl', () => {
    expect(() => validateConfig(withLinks([{ category: 'events', url: 'http://x.org' }]))).toThrow('getInvolved.links[0].url');
    expect(() => validateConfig(withLinks([{ category: 'events', url: 'https://x.org', calendarUrl: 'webcal://x.org/a.ics' }]))).toThrow(
      'getInvolved.links[0].calendarUrl'
    );
  });

  it('requires a label on transit and civic links', () => {
    expect(() => validateConfig(withLinks([{ category: 'transit', url: 'https://x.org' }]))).toThrow('label" is required for transit');
    expect(() => validateConfig(withLinks([{ category: 'civic', label: ' ', url: 'https://x.org' }]))).toThrow('non-blank');
  });
});

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

  it('accepts config with no email.replyTo (optional)', () => {
    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it('accepts a string email.replyTo', () => {
    const cfg = { ...validConfig, email: { ...validConfig.email, replyTo: 'contactus@example.org' } };
    expect(validateConfig(cfg).email.replyTo).toBe('contactus@example.org');
  });

  it('throws when email.replyTo is present but not a string', () => {
    const cfg = { ...validConfig, email: { ...validConfig.email, replyTo: 12345 } };
    expect(() => validateConfig(cfg)).toThrow(/email\.replyTo/);
  });

  it('throws when auth is missing a key', () => {
    const { portalBaseUrl, ...rest } = validConfig.auth;
    const broken = { ...validConfig, auth: rest };
    expect(() => validateConfig(broken)).toThrow(/portalBaseUrl/);
  });

  it('throws when auth.letterLinkTtlHours is missing', () => {
    const { letterLinkTtlHours, ...rest } = validConfig.auth;
    const broken = { ...validConfig, auth: rest };
    expect(() => validateConfig(broken)).toThrow(/auth\.letterLinkTtlHours/);
  });

  // The letter email's login link is a bearer credential that sits in an inbox for days — long
  // enough to be useful (issue #31: 15 minutes produced dead January links), capped at a week so
  // a typo can't mint month-long credentials.
  it.each([0, -1, 169, '72', Number.NaN])('rejects auth.letterLinkTtlHours = %s', (value) => {
    const broken = { ...validConfig, auth: { ...validConfig.auth, letterLinkTtlHours: value } };
    expect(() => validateConfig(broken)).toThrow(/auth\.letterLinkTtlHours/);
  });

  it.each([1, 72, 168])('accepts auth.letterLinkTtlHours = %s', (value) => {
    const cfg = { ...validConfig, auth: { ...validConfig.auth, letterLinkTtlHours: value } };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('throws when rateLimit.attemptRetentionHours is missing', () => {
    const { attemptRetentionHours, ...rest } = validConfig.rateLimit;
    const broken = { ...validConfig, rateLimit: rest };
    expect(() => validateConfig(broken)).toThrow(/rateLimit\.attemptRetentionHours/);
  });

  // The daily cap reads login_attempts back 24 hours — purging any sooner would silently loosen it.
  it.each([0, -1, 0.25, 23.9, '24'])('rejects rateLimit.attemptRetentionHours = %s (short of the 24-hour daily cap)', (value) => {
    const broken = { ...validConfig, rateLimit: { ...validConfig.rateLimit, attemptRetentionHours: value } };
    expect(() => validateConfig(broken)).toThrow(/rateLimit\.attemptRetentionHours/);
  });

  it('rejects a retention shorter than an emailWindowSeconds longer than a day', () => {
    const rateLimit = { ...validConfig.rateLimit, emailWindowSeconds: 172_800, attemptRetentionHours: 24 };
    expect(() => validateConfig({ ...validConfig, rateLimit })).toThrow(/rateLimit\.attemptRetentionHours/);
  });

  it('accepts rateLimit.attemptRetentionHours of exactly 24', () => {
    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it.each(['emailCooldownSeconds', 'emailWindowSeconds', 'emailMaxAttempts', 'emailDailyMax'] as const)(
    'rejects a non-positive or non-integer rateLimit.%s',
    (key) => {
      for (const value of [0, -1, 1.5, '5']) {
        const broken = { ...validConfig, rateLimit: { ...validConfig.rateLimit, [key]: value } };
        expect(() => validateConfig(broken)).toThrow(new RegExp(`rateLimit\\.${key}`));
      }
    }
  );

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
    officeAddress: '123 Example St, San Jose, CA 95112',
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

describe('donations config section', () => {
  it('rejects a config missing the donations section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).donations;
    expect(() => validateConfig(cfg)).toThrow('donations');
  });

  it('rejects a config missing donations.countableStatuses', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { donations: Record<string, unknown> }).donations.countableStatuses;
    expect(() => validateConfig(cfg)).toThrow('donations.countableStatuses');
  });

  it('rejects countableStatuses that is not an array of strings', () => {
    const cfg = structuredClone(validConfig);
    (cfg as { donations: { countableStatuses: unknown } }).donations.countableStatuses = [1, 2];
    expect(() => validateConfig(cfg)).toThrow(/countableStatuses/);
  });

  it('rejects an empty countableStatuses array (it would filter out every gift)', () => {
    const cfg = structuredClone(validConfig);
    cfg.donations.countableStatuses = [];
    expect(() => validateConfig(cfg)).toThrow(/countableStatuses/);
  });

  it('rejects a config missing donations.historyStartISO', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { donations: Record<string, unknown> }).donations.historyStartISO;
    expect(() => validateConfig(cfg)).toThrow('donations.historyStartISO');
  });

  it('rejects a config missing donations.historyVisibleFromISO', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { donations: Record<string, unknown> }).donations.historyVisibleFromISO;
    expect(() => validateConfig(cfg)).toThrow('donations.historyVisibleFromISO');
  });

  it('accepts null for both donation-history dates', () => {
    const cfg = structuredClone(validConfig);
    (cfg.donations as { historyStartISO: string | null }).historyStartISO = null;
    (cfg.donations as { historyVisibleFromISO: string | null }).historyVisibleFromISO = null;
    expect(validateConfig(cfg).donations).toMatchObject({ historyStartISO: null, historyVisibleFromISO: null });
  });

  it('rejects a donation-history date that is not YYYY-MM-DD', () => {
    const cfg = structuredClone(validConfig);
    cfg.donations.historyStartISO = '1/1/2026';
    expect(() => validateConfig(cfg)).toThrow(/historyStartISO.*YYYY-MM-DD/);
    const cfg2 = structuredClone(validConfig);
    cfg2.donations.historyVisibleFromISO = '2027-1-1';
    expect(() => validateConfig(cfg2)).toThrow(/historyVisibleFromISO.*YYYY-MM-DD/);
  });

  it('rejects a donation-history date that is not a real calendar date', () => {
    const cfg = structuredClone(validConfig);
    cfg.donations.historyStartISO = '2026-02-30';
    expect(() => validateConfig(cfg)).toThrow(/historyStartISO/);
  });

  it('rejects a config missing monday.columns.donationStatus entirely', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.monday.columns as Record<string, unknown>).donationStatus;
    expect(() => validateConfig(cfg)).toThrow(/monday\.columns\.donationStatus/);
  });

  it('rejects donationStatus still set to the placeholder (deploy-blocking, like the other donation columns)', () => {
    const cfg = structuredClone(validConfig);
    cfg.monday.columns.donationStatus = 'REPLACE_WITH_COLUMN_ID';
    expect(() => validateConfig(cfg)).toThrow(/donationStatus/);
  });
});

describe('eventRegistrations config section', () => {
  it('rejects a config missing the eventRegistrations section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).eventRegistrations;
    expect(() => validateConfig(cfg)).toThrow('eventRegistrations');
  });

  it('rejects a config missing eventRegistrations.boardId', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { eventRegistrations: Record<string, unknown> }).eventRegistrations.boardId;
    expect(() => validateConfig(cfg)).toThrow('eventRegistrations.boardId');
  });

  it('rejects a config missing an eventRegistrations column key', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { eventRegistrations: { columns: Record<string, unknown> } }).eventRegistrations.columns.attendeeLink;
    expect(() => validateConfig(cfg)).toThrow('eventRegistrations.columns.attendeeLink');
  });

  it('rejects a config missing eventRegistrations.eventDateColumnId', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { eventRegistrations: Record<string, unknown> }).eventRegistrations.eventDateColumnId;
    expect(() => validateConfig(cfg)).toThrow('eventRegistrations.eventDateColumnId');
  });

  it('accepts placeholder column ids (gate, not error) — same treatment as changeRequests', () => {
    const cfg = structuredClone(validConfig);
    cfg.eventRegistrations.boardId = null as unknown as number;
    cfg.eventRegistrations.columns.attendeeLink = 'REPLACE_WITH_COLUMN_ID';
    cfg.eventRegistrations.eventDateColumnId = 'REPLACE_WITH_COLUMN_ID';
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

describe('eventsEnabled', () => {
  it('is true when boardId is set and no column is a placeholder', () => {
    const cfg = validateConfig(structuredClone(validConfig));
    expect(eventsEnabled(cfg)).toBe(true);
  });

  it('is false when boardId is null', () => {
    const raw = structuredClone(validConfig);
    (raw as { eventRegistrations: { boardId: number | null } }).eventRegistrations.boardId = null;
    expect(eventsEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while a registrations column id is a placeholder', () => {
    const raw = structuredClone(validConfig);
    raw.eventRegistrations.columns.attended = 'REPLACE_WITH_COLUMN_ID';
    expect(eventsEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while eventDateColumnId is a placeholder', () => {
    const raw = structuredClone(validConfig);
    raw.eventRegistrations.eventDateColumnId = 'REPLACE_WITH_COLUMN_ID';
    expect(eventsEnabled(validateConfig(raw))).toBe(false);
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

describe('funraise section', () => {
  it('rejects a config missing the funraise section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).funraise;
    expect(() => validateConfig(cfg)).toThrow('funraise');
  });

  it('rejects a config missing funraise.renewMembershipUrl', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as { funraise: Record<string, unknown> }).funraise.renewMembershipUrl;
    expect(() => validateConfig(cfg)).toThrow('funraise.renewMembershipUrl');
  });

  it('accepts the placeholder and the empty string (gate, not error)', () => {
    const cfg = structuredClone(validConfig);
    cfg.funraise.manageRecurringUrl = 'REPLACE_WITH_FUNRAISE_URL';
    cfg.funraise.renewMembershipUrl = '';
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a set URL that is not https://', () => {
    const cfg = structuredClone(validConfig);
    cfg.funraise.renewMembershipUrl = 'http://example.funraise.org/give';
    expect(() => validateConfig(cfg)).toThrow(/funraise\.renewMembershipUrl.*https/);
  });

  it('rejects a non-string URL value', () => {
    const cfg = structuredClone(validConfig);
    (cfg as { funraise: { manageRecurringUrl: unknown } }).funraise.manageRecurringUrl = 42;
    expect(() => validateConfig(cfg)).toThrow(/funraise\.manageRecurringUrl.*string/);
  });
});

describe('funraiseLinks', () => {
  it('returns both URLs when both are configured', () => {
    const cfg = validateConfig(validConfig);
    expect(funraiseLinks(cfg)).toEqual({
      manageRecurringUrl: 'https://example.funraise.org/account',
      renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
    });
  });

  it('gates each link independently — placeholder or empty resolves to null', () => {
    const raw = structuredClone(validConfig);
    raw.funraise.manageRecurringUrl = 'REPLACE_WITH_FUNRAISE_URL';
    const cfg = validateConfig(raw);
    expect(funraiseLinks(cfg)).toEqual({
      manageRecurringUrl: null,
      renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
    });

    const rawEmpty = structuredClone(validConfig);
    rawEmpty.funraise.renewMembershipUrl = '';
    expect(funraiseLinks(validateConfig(rawEmpty)).renewMembershipUrl).toBeNull();
  });
});

describe('impact config section', () => {
  type YearStatements = Record<string, unknown>;
  const withYear = (year: string, statements: YearStatements) => {
    const cfg = structuredClone(validConfig);
    (cfg.impact.statementsByYear as Record<string, YearStatements>) = { [year]: statements };
    return cfg;
  };

  it('rejects a config missing the impact section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).impact;
    expect(() => validateConfig(cfg)).toThrow('"impact"');
  });

  it('rejects an impact section without statementsByYear', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.impact as Record<string, unknown>).statementsByYear;
    expect(() => validateConfig(cfg)).toThrow('impact.statementsByYear');
  });

  it('accepts no statements at all (the feature off)', () => {
    const cfg = structuredClone(validConfig);
    (cfg.impact.statementsByYear as Record<string, YearStatements>) = {};
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a year key that is not four digits', () => {
    expect(() => validateConfig(withYear('26', { en: ['A statement'] }))).toThrow('impact.statementsByYear.26');
  });

  it('rejects a year without English statements', () => {
    expect(() => validateConfig(withYear('2026', { es: ['Una frase'] }))).toThrow('impact.statementsByYear.2026.en');
  });

  it('rejects a locale code the portal does not support', () => {
    expect(() => validateConfig(withYear('2026', { en: ['A statement'], xx: ['?'] }))).toThrow('impact.statementsByYear.2026.xx');
  });

  it('rejects an empty statement list', () => {
    expect(() => validateConfig(withYear('2026', { en: [] }))).toThrow('impact.statementsByYear.2026.en');
  });

  it('rejects a blank or non-string statement', () => {
    expect(() => validateConfig(withYear('2026', { en: ['A statement'], es: ['  '] }))).toThrow('impact.statementsByYear.2026.es');
    expect(() => validateConfig(withYear('2026', { en: ['A statement'], es: [42] }))).toThrow('impact.statementsByYear.2026.es');
  });
});

describe('pledges + matchingGifts config sections', () => {
  it('rejects a config missing the pledges section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).pledges;
    expect(() => validateConfig(cfg)).toThrow('pledges');
  });

  it('rejects a config missing a pledges column key', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.pledges.columns as Record<string, unknown>).fulfilledAmount;
    expect(() => validateConfig(cfg)).toThrow('pledges.columns.fulfilledAmount');
  });

  it('rejects a config missing the matchingGifts section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).matchingGifts;
    expect(() => validateConfig(cfg)).toThrow('matchingGifts');
  });

  it('accepts placeholder pledge columns and a null DTD key (gates, not errors)', () => {
    const cfg = structuredClone(validConfig);
    (cfg.pledges as { boardId: number | null }).boardId = null;
    cfg.pledges.columns.donorLink = 'REPLACE_WITH_COLUMN_ID';
    (cfg.matchingGifts as { doubleTheDonationPublicKey: string | null }).doubleTheDonationPublicKey = null;
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('letterCron config section', () => {
  it('rejects a config missing the letterCron section', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg as Record<string, unknown>).letterCron;
    expect(() => validateConfig(cfg)).toThrow(/letterCron/);
  });

  it('rejects a config missing a letterCron column key', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.letterCron.columns as Record<string, unknown>).bodyTemplate;
    expect(() => validateConfig(cfg)).toThrow(/letterCron\.columns\.bodyTemplate/);
  });

  it('rejects letterCron.maxTriggersPerRun that is not a positive number', () => {
    const cfg = structuredClone(validConfig);
    cfg.letterCron.maxTriggersPerRun = 0;
    expect(() => validateConfig(cfg)).toThrow(/maxTriggersPerRun/);
  });

  it('accepts letterCron placeholder column ids (gate, not error)', () => {
    const cfg = structuredClone(validConfig);
    cfg.letterCron.columns.autoSend = 'REPLACE_WITH_COLUMN_ID';
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a config missing letterCron.columns.bodyTemplatesByLocale', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.letterCron.columns as Record<string, unknown>).bodyTemplatesByLocale;
    expect(() => validateConfig(cfg)).toThrow(/letterCron\.columns\.bodyTemplatesByLocale/);
  });

  it('rejects a bodyTemplatesByLocale key that is not a supported locale', () => {
    const cfg = structuredClone(validConfig);
    (cfg.letterCron.columns.bodyTemplatesByLocale as Record<string, string>)['xx'] = 'long_text_xx';
    expect(() => validateConfig(cfg)).toThrow(/xx/);
  });

  it('accepts an empty bodyTemplatesByLocale (every locale falls back)', () => {
    const cfg = structuredClone(validConfig);
    (cfg.letterCron.columns as Record<string, unknown>).bodyTemplatesByLocale = {};
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('defaults letterCron.settingsItemName to "Letter emails" when absent', () => {
    const cfg = structuredClone(validConfig);
    delete (cfg.letterCron as Record<string, unknown>).settingsItemName;
    expect(validateConfig(cfg).letterCron.settingsItemName).toBe('Letter emails');
  });

  it('keeps a configured letterCron.settingsItemName', () => {
    const cfg = structuredClone(validConfig);
    (cfg.letterCron as Record<string, unknown>).settingsItemName = 'Custom settings item';
    expect(validateConfig(cfg).letterCron.settingsItemName).toBe('Custom settings item');
  });

  it('rejects a blank letterCron.settingsItemName', () => {
    const cfg = structuredClone(validConfig);
    (cfg.letterCron as Record<string, unknown>).settingsItemName = '   ';
    expect(() => validateConfig(cfg)).toThrow(/letterCron\.settingsItemName/);
  });

  it('rejects a non-string letterCron.settingsItemName', () => {
    const cfg = structuredClone(validConfig);
    (cfg.letterCron as Record<string, unknown>).settingsItemName = 42;
    expect(() => validateConfig(cfg)).toThrow(/letterCron\.settingsItemName/);
  });
});

describe('communication preference columns', () => {
  const PREF_COLUMNS = ['donorEmailOptOut', 'donorSmsOptOut', 'donorDoNotMail'] as const;

  for (const column of PREF_COLUMNS) {
    it(`rejects config missing ${column} entirely`, () => {
      const cfg = structuredClone(validConfig);
      delete (cfg.monday.columns as Record<string, unknown>)[column];
      expect(() => validateConfig(cfg)).toThrow(new RegExp(`monday\\.columns\\.${column}`));
    });
  }

  it('accepts the preference columns as placeholders (gated, not deploy-blocking)', () => {
    const cfg = structuredClone(validConfig);
    for (const column of PREF_COLUMNS) {
      (cfg.monday.columns as Record<string, unknown>)[column] = 'REPLACE_WITH_COLUMN_ID';
    }
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('pledgesEnabled', () => {
  it('is true when boardId is set and no pledge column is a placeholder', () => {
    expect(pledgesEnabled(validateConfig(validConfig))).toBe(true);
  });

  it('is false when boardId is null', () => {
    const raw = structuredClone(validConfig);
    (raw.pledges as { boardId: number | null }).boardId = null;
    expect(pledgesEnabled(validateConfig(raw))).toBe(false);
  });

  it('is false while a pledge column id is a placeholder', () => {
    const raw = structuredClone(validConfig);
    raw.pledges.columns.pledgedAmount = 'REPLACE_WITH_COLUMN_ID';
    expect(pledgesEnabled(validateConfig(raw))).toBe(false);
  });
});

describe('signedOffEin', () => {
  it('returns the EIN once real, null while placeholder or empty', () => {
    expect(signedOffEin(validateConfig(validConfig))).toBe('00-0000000');
    const raw = structuredClone(validConfig);
    raw.taxLetter.ein = 'REPLACE_AFTER_SIGNOFF';
    expect(signedOffEin(validateConfig(raw))).toBeNull();
    raw.taxLetter.ein = '';
    expect(signedOffEin(validateConfig(raw))).toBeNull();
  });
});

describe('matchingGiftsSearchEnabled', () => {
  it('is true when a public key is configured', () => {
    expect(matchingGiftsSearchEnabled(validateConfig(validConfig))).toBe(true);
  });

  it('is false when the key is null or empty', () => {
    const raw = structuredClone(validConfig);
    (raw.matchingGifts as { doubleTheDonationPublicKey: string | null }).doubleTheDonationPublicKey = null;
    expect(matchingGiftsSearchEnabled(validateConfig(raw))).toBe(false);
    (raw.matchingGifts as { doubleTheDonationPublicKey: string | null }).doubleTheDonationPublicKey = '';
    expect(matchingGiftsSearchEnabled(validateConfig(raw))).toBe(false);
  });
});

describe('configuredPrefFields', () => {
  it('returns every preference field when all three columns are configured', () => {
    expect(configuredPrefFields(validateConfig(structuredClone(validConfig)))).toEqual([
      'emailOptOut',
      'smsOptOut',
      'doNotMail',
    ]);
  });

  it('returns [] while every preference column is a placeholder', () => {
    const cfg = structuredClone(validConfig);
    cfg.monday.columns.donorEmailOptOut = 'REPLACE_WITH_COLUMN_ID';
    cfg.monday.columns.donorSmsOptOut = 'REPLACE_WITH_COLUMN_ID';
    cfg.monday.columns.donorDoNotMail = 'REPLACE_WITH_COLUMN_ID';
    expect(configuredPrefFields(validateConfig(cfg))).toEqual([]);
  });

  it('returns only the fields whose columns are configured (independent gating)', () => {
    const cfg = structuredClone(validConfig);
    cfg.monday.columns.donorSmsOptOut = 'REPLACE_WITH_COLUMN_ID';
    expect(configuredPrefFields(validateConfig(cfg))).toEqual(['emailOptOut', 'doNotMail']);
  });
});

describe('letterCronConfigured', () => {
  it('is true when boardId is set and no column is a placeholder', () => {
    expect(letterCronConfigured(validateConfig(structuredClone(validConfig)))).toBe(true);
  });

  it('is false when boardId is null', () => {
    const raw = structuredClone(validConfig);
    (raw.letterCron as { boardId: number | null }).boardId = null;
    expect(letterCronConfigured(validateConfig(raw))).toBe(false);
  });

  it('is false while a letterCron column id is a placeholder', () => {
    const raw = structuredClone(validConfig);
    raw.letterCron.columns.startDate = 'REPLACE_WITH_COLUMN_ID';
    expect(letterCronConfigured(validateConfig(raw))).toBe(false);
  });
});

describe('donationHistoryEnabled', () => {
  const at = (iso: string) => new Date(iso);

  it('is false before historyVisibleFromISO', () => {
    const cfg = validateConfig(validConfig);
    expect(donationHistoryEnabled(cfg, at('2026-12-31T23:59:59Z'))).toBe(false);
  });

  it('is true from the first UTC instant of historyVisibleFromISO onward', () => {
    const cfg = validateConfig(validConfig);
    expect(donationHistoryEnabled(cfg, at('2027-01-01T00:00:00Z'))).toBe(true);
    expect(donationHistoryEnabled(cfg, at('2030-06-15T12:00:00Z'))).toBe(true);
  });

  it('is false when historyVisibleFromISO is null, regardless of the date', () => {
    const raw = structuredClone(validConfig);
    (raw.donations as { historyVisibleFromISO: string | null }).historyVisibleFromISO = null;
    expect(donationHistoryEnabled(validateConfig(raw), at('2030-01-01T00:00:00Z'))).toBe(false);
  });
});
