import { giftTypeIn } from './letters/giftTypes';
import type { Config, EmployerAnswerConfig, FunraiseLinkUrls, MondayColumns, PrefField } from './types';
import { isLocale } from './i18n/locales';

const REQUIRED_TOP_LEVEL = [
  'monday',
  'email',
  'auth',
  'rateLimit',
  'taxLetter',
  'changeRequests',
  'cardTokens',
  'volunteerHistory',
  'donations',
  'eventRegistrations',
  'funraise',
  'getInvolved',
  'pledges',
  'matchingGifts',
  'impact',
  'letterCron',
] as const;

const REQUIRED_COLUMNS: (keyof MondayColumns)[] = [
  'donorEmail',
  'membershipStatus',
  'membershipTier',
  'dollarDonated',
  'donationDonorLink',
  'donationAmount',
  'donationDate',
  'donationDescription',
  'donationStatus',
  'discountOffered',
  'discountActive',
];

// V2_DONOR_COLUMNS deliberately isn't merged into REQUIRED_COLUMNS: these two columns only
// matter to the change-request feature, which is gated (changeRequestsEnabled), not
// deploy-blocking. They're checked for *presence* only, not placeholder-freedom.
const V2_DONOR_COLUMNS: (keyof MondayColumns)[] = ['donorAddress', 'donorPhone'];

// CARD_COLUMNS deliberately isn't merged into REQUIRED_COLUMNS: this column only matters to the
// membership-card feature, which is gated (cardEnabled), not deploy-blocking. Checked for
// *presence* only, not placeholder-freedom — same treatment as V2_DONOR_COLUMNS.
const CARD_COLUMNS: (keyof MondayColumns)[] = ['membershipExpiry'];

// PREFERRED_LANGUAGE_COLUMN deliberately isn't merged into REQUIRED_COLUMNS: this column only
// matters to the i18n feature, which is gated, not deploy-blocking. Checked for *presence* only,
// not placeholder-freedom — same treatment as CARD_COLUMNS.
const PREFERRED_LANGUAGE_COLUMN: (keyof MondayColumns)[] = ['preferredLanguage'];

// VOLUNTEER_COLUMNS deliberately isn't merged into REQUIRED_COLUMNS: these columns only matter
// to the volunteer-history feature, which is gated (volunteerHistoryEnabled), not
// deploy-blocking. Checked for *presence* only, not placeholder-freedom — same treatment as
// CARD_COLUMNS.
const VOLUNTEER_COLUMNS: (keyof MondayColumns)[] = [
  'volunteerDonorLink',
  'volunteerHours',
  'volunteerDate',
  'volunteerJob',
  'volunteerStatus',
];

// MATCH_COLUMNS deliberately aren't merged into REQUIRED_COLUMNS: they only matter to the DTD
// match-line feature, which is gated as a set (matchLinesEnabled), not deploy-blocking. Checked
// for *presence* only, not placeholder-freedom — same treatment as VOLUNTEER_COLUMNS.
const MATCH_COLUMNS: (keyof MondayColumns)[] = [
  'donationMatchesGift',
  'donationMatchStatus',
  'donationMatchedBy',
  'donorDtdLink',
];

// COMM_PREF_COLUMNS deliberately isn't merged into REQUIRED_COLUMNS: each column only matters to
// the communication-preferences feature, which is gated per column (configuredPrefFields), not
// deploy-blocking. Checked for *presence* only, not placeholder-freedom — same treatment as
// V2_DONOR_COLUMNS.
const COMM_PREF_COLUMNS: (keyof MondayColumns)[] = ['donorEmailOptOut', 'donorSmsOptOut', 'donorDoNotMail'];

// EMPLOYER_COLUMN only matters to the donor employer answer, gated by employerAnswerEnabled.
// Presence only, not placeholder-freedom — same treatment as COMM_PREF_COLUMNS.
const EMPLOYER_COLUMN: (keyof MondayColumns)[] = ['donorEmployer'];
const EMPLOYER_AFFILIATION_COLUMNS = ['personLink', 'organizationLink', 'status', 'primary'] as const;

// Which Donors-board checkbox column backs each preference field. Also fixes the order the
// preferences render in on the change-request form.
export const PREF_FIELD_COLUMNS: Record<PrefField, keyof MondayColumns> = {
  emailOptOut: 'donorEmailOptOut',
  smsOptOut: 'donorSmsOptOut',
  doNotMail: 'donorDoNotMail',
};

const PLACEHOLDER_COLUMN_VALUE = 'REPLACE_WITH_COLUMN_ID';
const SIGNOFF_PLACEHOLDER = 'REPLACE_AFTER_SIGNOFF';

const REQUIRED_EMAIL_KEYS = ['fromAddress', 'fromName', 'logoUrl'] as const;
const REQUIRED_AUTH_KEYS = ['magicLinkTtlMinutes', 'letterLinkTtlHours', 'sessionTtlHours', 'portalBaseUrl'] as const;
// Upper bound on the letter email's login-link lifetime: long enough that a donor who opens the
// January email days later still gets in (issue #31), short enough that a typo can't mint
// month-long bearer credentials sitting in inboxes.
const MAX_LETTER_LINK_TTL_HOURS = 168;
const REQUIRED_RATE_LIMIT_KEYS = [
  'emailCooldownSeconds',
  'emailWindowSeconds',
  'emailMaxAttempts',
  'emailDailyMax',
  'attemptRetentionHours',
] as const;
const REQUIRED_TAX_LETTER_KEYS = [
  'orgLegalName',
  'ein',
  'officeAddress',
  'signatureName',
  'signatureTitle',
  'plainStatement',
  'benefitStatement',
  'benefitTiers',
  'excludedGiftTypes',
  'separateGiftTypes',
  'separateGiftsStatement',
] as const;
const REQUIRED_CHANGE_REQUEST_KEYS = ['boardId', 'columns', 'dedupeWindowHours', 'retentionDays'] as const;
const REQUIRED_CHANGE_REQUEST_COLUMNS = ['donorLink', 'field', 'oldValue', 'newValue', 'submittedAt'] as const;
const REQUIRED_CARD_TOKENS_KEYS = ['retentionDays'] as const;
const REQUIRED_LETTER_CRON_KEYS = ['boardId', 'columns', 'maxTriggersPerRun'] as const;
const DEFAULT_LETTER_SETTINGS_ITEM_NAME = 'Letter emails';
const REQUIRED_LETTER_CRON_COLUMNS = ['autoSend', 'startDate', 'bodyTemplate'] as const;
const REQUIRED_VOLUNTEER_HISTORY_KEYS = ['completedStatuses'] as const;
const REQUIRED_DONATIONS_KEYS = ['countableStatuses', 'historyStartISO', 'historyVisibleFromISO'] as const;
// Presence-checked only, never placeholder-checked: event registrations are gated
// (eventsEnabled), not deploy-blocking — same treatment as changeRequests' columns.
const REQUIRED_EVENT_REGISTRATION_KEYS = ['boardId', 'columns', 'eventDateColumnId'] as const;
const REQUIRED_EVENT_REGISTRATION_COLUMNS = ['attendeeLink', 'eventLink', 'attended'] as const;
const REQUIRED_FUNRAISE_KEYS = ['manageRecurringUrl', 'renewMembershipUrl'] as const;
const FUNRAISE_URL_PLACEHOLDER = 'REPLACE_WITH_FUNRAISE_URL';
const GET_INVOLVED_CATEGORIES = ['transit', 'civic', 'events', 'volunteer'] as const;
const REQUIRED_PLEDGES_KEYS = ['boardId', 'columns'] as const;
const REQUIRED_PLEDGE_COLUMNS = ['donorLink', 'pledgedAmount', 'fulfilledAmount', 'status', 'dueDate'] as const;
const REQUIRED_MATCHING_GIFTS_KEYS = ['doubleTheDonationPublicKey'] as const;

function requireObject(cfg: Record<string, unknown>, key: string, errorKey: string = key): Record<string, unknown> {
  const value = cfg[key];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${errorKey}"`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(obj: Record<string, unknown>, prefix: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!(key in obj)) {
      throw new Error(`config: missing required key "${prefix}.${key}"`);
    }
  }
}

function requireNoPlaceholderColumns(columns: Record<string, unknown>): void {
  for (const key of REQUIRED_COLUMNS) {
    if (columns[key] === PLACEHOLDER_COLUMN_VALUE) {
      throw new Error(
        `config: monday.columns.${key} is still set to the placeholder value "${PLACEHOLDER_COLUMN_VALUE}" — ` +
          'replace it with the real Monday column id before deploying'
      );
    }
  }
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in cfg)) {
      throw new Error(`config: missing required key "${key}"`);
    }
  }

  const monday = requireObject(cfg, 'monday');
  // volunteersBoardId must exist as an explicit number-or-null: volunteerHistoryEnabled gates
  // on it, and a missing key (undefined) or a string id would otherwise slip past a `=== null`
  // check and send Monday a query against board 0.
  if (!('volunteersBoardId' in monday) || (monday.volunteersBoardId !== null && typeof monday.volunteersBoardId !== 'number')) {
    throw new Error('config: "monday.volunteersBoardId" must be a number or null');
  }
  const columns = requireObject(monday, 'columns');
  requireKeys(columns, 'monday.columns', REQUIRED_COLUMNS);
  requireNoPlaceholderColumns(columns);
  requireKeys(columns, 'monday.columns', V2_DONOR_COLUMNS);
  requireKeys(columns, 'monday.columns', CARD_COLUMNS);
  requireKeys(columns, 'monday.columns', PREFERRED_LANGUAGE_COLUMN);
  requireKeys(columns, 'monday.columns', VOLUNTEER_COLUMNS);
  requireKeys(columns, 'monday.columns', MATCH_COLUMNS);
  requireKeys(columns, 'monday.columns', COMM_PREF_COLUMNS);
  requireKeys(columns, 'monday.columns', EMPLOYER_COLUMN);

  const email = requireObject(cfg, 'email');
  requireKeys(email, 'email', REQUIRED_EMAIL_KEYS);
  if ('replyTo' in email && typeof email.replyTo !== 'string') {
    throw new Error('config: "email.replyTo" must be a string when present');
  }

  const auth = requireObject(cfg, 'auth');
  requireKeys(auth, 'auth', REQUIRED_AUTH_KEYS);
  const letterLinkTtlHours = auth.letterLinkTtlHours;
  if (
    typeof letterLinkTtlHours !== 'number' ||
    !Number.isFinite(letterLinkTtlHours) ||
    letterLinkTtlHours <= 0 ||
    letterLinkTtlHours > MAX_LETTER_LINK_TTL_HOURS
  ) {
    throw new Error(`config: "auth.letterLinkTtlHours" must be a number of hours in (0, ${MAX_LETTER_LINK_TTL_HOURS}]`);
  }

  const rateLimit = requireObject(cfg, 'rateLimit');
  requireKeys(rateLimit, 'rateLimit', REQUIRED_RATE_LIMIT_KEYS);
  for (const key of ['emailCooldownSeconds', 'emailWindowSeconds', 'emailMaxAttempts', 'emailDailyMax'] as const) {
    const value = rateLimit[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`config: "rateLimit.${key}" must be a positive integer`);
    }
  }
  // The daily purge deletes login_attempts older than this; anything shorter than the longest
  // look-back (the 24-hour daily cap, or the window if longer) would silently loosen the limit
  // it exists to enforce.
  const lookbackHours = Math.max(24, (rateLimit.emailWindowSeconds as number) / 3600);
  if (typeof rateLimit.attemptRetentionHours !== 'number' || !(rateLimit.attemptRetentionHours >= lookbackHours)) {
    throw new Error(
      'config: "rateLimit.attemptRetentionHours" must be a number of hours covering both 24 hours (the daily cap) and rateLimit.emailWindowSeconds'
    );
  }

  const taxLetter = requireObject(cfg, 'taxLetter');
  requireKeys(taxLetter, 'taxLetter', REQUIRED_TAX_LETTER_KEYS);
  // A mistyped shape here would silently print the wrong gifts on a tax document, so fail at
  // startup. A label in both lists has no single right treatment, so that fails too.
  for (const key of ['excludedGiftTypes', 'separateGiftTypes'] as const) {
    const labels = taxLetter[key];
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string' || label.trim().length === 0)) {
      throw new Error(`config: "taxLetter.${key}" must be an array of non-empty strings`);
    }
  }
  const separateLabels = taxLetter.separateGiftTypes as string[];
  const overlap = (taxLetter.excludedGiftTypes as string[]).find((label) => giftTypeIn(separateLabels, label));
  if (overlap !== undefined) {
    throw new Error(`config: "${overlap}" is in both taxLetter.excludedGiftTypes and taxLetter.separateGiftTypes`);
  }

  const changeRequests = requireObject(cfg, 'changeRequests');
  requireKeys(changeRequests, 'changeRequests', REQUIRED_CHANGE_REQUEST_KEYS);
  const crColumns = requireObject(changeRequests, 'columns', 'changeRequests.columns');
  requireKeys(crColumns, 'changeRequests.columns', REQUIRED_CHANGE_REQUEST_COLUMNS);
  if (typeof changeRequests.retentionDays !== 'number' || changeRequests.retentionDays <= 0) {
    throw new Error('config: "changeRequests.retentionDays" must be a positive number of days');
  }
  changeRequests.employer = validateEmployerAnswer(changeRequests.employer);

  const cardTokens = requireObject(cfg, 'cardTokens');
  requireKeys(cardTokens, 'cardTokens', REQUIRED_CARD_TOKENS_KEYS);
  if (typeof cardTokens.retentionDays !== 'number' || cardTokens.retentionDays <= 0) {
    throw new Error('config: "cardTokens.retentionDays" must be a positive number of days');
  }

  const letterCron = requireObject(cfg, 'letterCron');
  requireKeys(letterCron, 'letterCron', REQUIRED_LETTER_CRON_KEYS);
  // The name of the board's single settings item, matched exactly by getLetterSettings (and
  // used by scripts/create-letter-settings-board.mjs when creating it). Optional with a
  // default, so an older config keeps working; a present-but-blank value is a config error,
  // not a silent match-nothing.
  if (!('settingsItemName' in letterCron)) {
    letterCron.settingsItemName = DEFAULT_LETTER_SETTINGS_ITEM_NAME;
  } else if (typeof letterCron.settingsItemName !== 'string' || letterCron.settingsItemName.trim() === '') {
    throw new Error('config: "letterCron.settingsItemName" must be a non-empty string');
  }
  const letterCronColumns = requireObject(letterCron, 'columns', 'letterCron.columns');
  requireKeys(letterCronColumns, 'letterCron.columns', REQUIRED_LETTER_CRON_COLUMNS);
  const byLocale = requireObject(letterCronColumns, 'bodyTemplatesByLocale', 'letterCron.columns.bodyTemplatesByLocale');
  for (const key of Object.keys(byLocale)) {
    if (!isLocale(key)) {
      throw new Error(`config: "letterCron.columns.bodyTemplatesByLocale" has unsupported locale key "${key}"`);
    }
  }
  if (typeof letterCron.maxTriggersPerRun !== 'number' || letterCron.maxTriggersPerRun <= 0) {
    throw new Error('config: "letterCron.maxTriggersPerRun" must be a positive number');
  }
  const volunteerHistory = requireObject(cfg, 'volunteerHistory');
  requireKeys(volunteerHistory, 'volunteerHistory', REQUIRED_VOLUNTEER_HISTORY_KEYS);
  const completedStatuses = volunteerHistory.completedStatuses;
  if (!Array.isArray(completedStatuses) || completedStatuses.some((s) => typeof s !== 'string')) {
    throw new Error('config: "volunteerHistory.completedStatuses" must be an array of strings');
  }
  const donations = requireObject(cfg, 'donations');
  requireKeys(donations, 'donations', REQUIRED_DONATIONS_KEYS);
  const countableStatuses = donations.countableStatuses;
  // Unlike volunteerHistory.completedStatuses (where empty means "include every status"), an
  // empty list here is rejected: it would filter every gift out of portal history and tax
  // letters, and an accidental [] silently zeroing donors' deductible totals is exactly the kind
  // of quiet financial error this key exists to prevent.
  if (
    !Array.isArray(countableStatuses) ||
    countableStatuses.length === 0 ||
    countableStatuses.some((s) => typeof s !== 'string')
  ) {
    throw new Error('config: "donations.countableStatuses" must be a non-empty array of strings');
  }
  requireISODateOrNull(donations, 'donations', 'historyStartISO');
  requireISODateOrNull(donations, 'donations', 'historyVisibleFromISO');
  const eventRegistrations = requireObject(cfg, 'eventRegistrations');
  requireKeys(eventRegistrations, 'eventRegistrations', REQUIRED_EVENT_REGISTRATION_KEYS);
  const erColumns = requireObject(eventRegistrations, 'columns', 'eventRegistrations.columns');
  requireKeys(erColumns, 'eventRegistrations.columns', REQUIRED_EVENT_REGISTRATION_COLUMNS);

  // The placeholder (or an empty string) is a gate, not an error — same treatment as the
  // taxLetter sign-off fields. But a *set* URL must be https: these links are rendered to
  // donors inside the authenticated portal, so a typo'd or http: URL should fail at deploy,
  // not in a donor's browser.
  const funraise = requireObject(cfg, 'funraise');
  requireKeys(funraise, 'funraise', REQUIRED_FUNRAISE_KEYS);
  for (const key of REQUIRED_FUNRAISE_KEYS) {
    const value = funraise[key];
    if (typeof value !== 'string') {
      throw new Error(`config: "funraise.${key}" must be a string`);
    }
    if (value !== FUNRAISE_URL_PLACEHOLDER && value !== '' && !value.startsWith('https://')) {
      throw new Error(`config: "funraise.${key}" must be an https:// URL (or the placeholder "${FUNRAISE_URL_PLACEHOLDER}")`);
    }
  }

  // Same reasoning as funraise: every URL here is rendered to donors, so a bad one fails at
  // deploy. An empty list is the gate (no section), not an error.
  const getInvolved = requireObject(cfg, 'getInvolved');
  const links = getInvolved['links'];
  if (!Array.isArray(links)) {
    throw new Error('config: "getInvolved.links" must be a list');
  }
  links.forEach((link: unknown, i) => {
    const path = `getInvolved.links[${i}]`;
    if (typeof link !== 'object' || link === null) {
      throw new Error(`config: "${path}" must be an object`);
    }
    const { category, label, url, calendarUrl } = link as Record<string, unknown>;
    if (!GET_INVOLVED_CATEGORIES.includes(category as (typeof GET_INVOLVED_CATEGORIES)[number])) {
      throw new Error(`config: "${path}.category" must be one of ${GET_INVOLVED_CATEGORIES.join(', ')}`);
    }
    if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
      throw new Error(`config: "${path}.label" must be a non-blank string when present`);
    }
    // transit/civic links have no translated fallback text, so they must name the committee.
    if (label === undefined && (category === 'transit' || category === 'civic')) {
      throw new Error(`config: "${path}.label" is required for ${category} links`);
    }
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error(`config: "${path}.url" must be an https:// URL`);
    }
    if (calendarUrl !== undefined && (typeof calendarUrl !== 'string' || !calendarUrl.startsWith('https://'))) {
      throw new Error(`config: "${path}.calendarUrl" must be an https:// URL when present`);
    }
  });

  // Both gated (pledgesEnabled / matchingGiftsSearchEnabled), not deploy-blocking — presence
  // checks only, same treatment as changeRequests' columns.
  const pledges = requireObject(cfg, 'pledges');
  requireKeys(pledges, 'pledges', REQUIRED_PLEDGES_KEYS);
  const pledgeColumns = requireObject(pledges, 'columns', 'pledges.columns');
  requireKeys(pledgeColumns, 'pledges.columns', REQUIRED_PLEDGE_COLUMNS);

  const matchingGifts = requireObject(cfg, 'matchingGifts');
  requireKeys(matchingGifts, 'matchingGifts', REQUIRED_MATCHING_GIFTS_KEYS);

  // An empty statementsByYear is the gate (nothing renders), not an error. What is set must be
  // well-formed: selectImpact matches year keys against the first four characters of a gift
  // date and falls back to `en`, so a "26" key or a year with no English would silently never
  // show.
  const impact = requireObject(cfg, 'impact');
  const statementsByYear = requireObject(impact, 'statementsByYear', 'impact.statementsByYear');
  for (const year of Object.keys(statementsByYear)) {
    const yearPath = `impact.statementsByYear.${year}`;
    if (!/^\d{4}$/.test(year)) {
      throw new Error(`config: "${yearPath}" must be keyed by a four-digit year`);
    }
    const locales = requireObject(statementsByYear, year, yearPath);
    requireKeys(locales, yearPath, ['en']);
    for (const [locale, statements] of Object.entries(locales)) {
      if (!isLocale(locale)) {
        throw new Error(`config: "${yearPath}.${locale}" is not a supported locale`);
      }
      const valid =
        Array.isArray(statements) && statements.length > 0 && statements.every((s) => typeof s === 'string' && s.trim().length > 0);
      if (!valid) {
        throw new Error(`config: "${yearPath}.${locale}" must be a non-empty list of non-blank strings`);
      }
    }
  }

  return cfg as unknown as Config;
}

// A date key that is either null (feature off / no floor) or a real YYYY-MM-DD calendar date.
// Both donation-history dates compare against Monday date-column text and Date.toISOString()
// slices as plain strings, so anything but the canonical form would silently misorder.
function requireISODateOrNull(obj: Record<string, unknown>, path: string, key: string): void {
  const value = obj[key];
  if (value === null) return;
  const valid =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid) {
    throw new Error(`config: "${path}.${key}" must be null or a YYYY-MM-DD calendar date`);
  }
}

// Donation history is date-gated rather than a boolean so the tab appears on its own once the
// clock passes donations.historyVisibleFromISO (SVBC: the first day of the first full calendar
// year after the clean start), with no January deploy. null means never shown — the safe
// default for a fresh fork and for shipping ahead of launch. `now` is a parameter so tests can
// pin the clock; compared as UTC date strings to match how the floor is applied.
export function donationHistoryEnabled(config: Config, now: Date): boolean {
  const from = config.donations.historyVisibleFromISO;
  if (from === null) return false;
  return now.toISOString().slice(0, 10) >= from;
}

export function lettersEnabled(config: Config): boolean {
  const t = config.taxLetter;
  const strings = [
    t.orgLegalName,
    t.ein,
    t.officeAddress,
    t.signatureName,
    t.signatureTitle,
    t.plainStatement,
    t.benefitStatement,
    t.separateGiftsStatement,
  ];
  return strings.every((s) => s !== SIGNOFF_PLACEHOLDER && s.length > 0);
}

function validateEmployerAnswer(raw: unknown): EmployerAnswerConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('config: "changeRequests.employer" must be an object or null');
  const block = raw as Record<string, unknown>;
  if (typeof block.affiliationsBoardId !== 'number' || !Number.isSafeInteger(block.affiliationsBoardId) || block.affiliationsBoardId <= 0) {
    throw new Error('config: "changeRequests.employer.affiliationsBoardId" must be a positive board id');
  }
  const columns = block.affiliationColumns;
  if (typeof columns !== 'object' || columns === null) {
    throw new Error('config: "changeRequests.employer.affiliationColumns" must be an object');
  }
  for (const key of EMPLOYER_AFFILIATION_COLUMNS) {
    const id = (columns as Record<string, unknown>)[key];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`config: "changeRequests.employer.affiliationColumns.${key}" must be a Monday column id string`);
    }
  }
  for (const key of ['currentStatusLabel', 'personAffiliationsLink'] as const) {
    if (typeof block[key] !== 'string' || (block[key] as string).length === 0) {
      throw new Error(`config: "changeRequests.employer.${key}" must be a non-empty string`);
    }
  }
  return raw as EmployerAnswerConfig;
}

// The Employer field shows only with change requests on, an employer block, and a real
// People → Employer Name column (the change request's old value).
export function employerAnswerEnabled(config: Config): boolean {
  return (
    changeRequestsEnabled(config) &&
    (config.changeRequests.employer ?? null) !== null &&
    config.monday.columns.donorEmployer !== PLACEHOLDER_COLUMN_VALUE
  );
}

export function changeRequestsEnabled(config: Config): boolean {
  const cr = config.changeRequests;
  if (cr.boardId === null) return false;
  const crCols = [cr.columns.donorLink, cr.columns.field, cr.columns.oldValue, cr.columns.newValue, cr.columns.submittedAt];
  const donorCols = [config.monday.columns.donorAddress, config.monday.columns.donorPhone];
  return [...crCols, ...donorCols].every((c) => c !== PLACEHOLDER_COLUMN_VALUE);
}

// Unlike the all-or-nothing changeRequestsEnabled gate, preferences gate per column: an operator
// can configure just the Email Opt-Out checkbox and ship that alone.
export function configuredPrefFields(config: Config): PrefField[] {
  return (Object.keys(PREF_FIELD_COLUMNS) as PrefField[]).filter((field) => {
    const columnId = config.monday.columns[PREF_FIELD_COLUMNS[field]];
    return typeof columnId === 'string' && columnId !== PLACEHOLDER_COLUMN_VALUE;
  });
}

// All four DTD match columns must be real: one placeholder turns the whole feature off, so the
// literal placeholder never reaches Monday.
export function matchLinesEnabled(config: Config): boolean {
  return MATCH_COLUMNS.every((key) => config.monday.columns[key] !== PLACEHOLDER_COLUMN_VALUE);
}

export function cardEnabled(config: Config): boolean {
  return config.monday.columns.membershipExpiry !== PLACEHOLDER_COLUMN_VALUE;
}

// True once an operator has created the Letter Settings board (scripts/
// create-letter-settings-board.mjs) and filled in its ids. Distinct from lettersEnabled: that
// gate is the IRS-language signoff, this one is board plumbing — the January cron needs both.
export function letterCronConfigured(config: Config): boolean {
  const lc = config.letterCron;
  if (lc.boardId === null) return false;
  return [lc.columns.autoSend, lc.columns.startDate, lc.columns.bodyTemplate].every(
    (c) => c !== PLACEHOLDER_COLUMN_VALUE
  );
}

export function volunteerHistoryEnabled(config: Config): boolean {
  // typeof check (not === null) so a missing/undefined or mistyped board id counts as disabled
  // rather than enabled-against-board-0.
  if (typeof config.monday.volunteersBoardId !== 'number') return false;
  return VOLUNTEER_COLUMNS.every((key) => config.monday.columns[key] !== PLACEHOLDER_COLUMN_VALUE);
}

export function eventsEnabled(config: Config): boolean {
  const er = config.eventRegistrations;
  if (er.boardId === null) return false;
  const ids = [er.columns.attendeeLink, er.columns.eventLink, er.columns.attended, er.eventDateColumnId];
  return ids.every((c) => c !== PLACEHOLDER_COLUMN_VALUE);
}

// Each Funraise deep link is gated independently — SVBC may have the donor-account URL before
// the renewal-checkout URL (or vice versa), and either alone is worth showing. Returns null for
// an unconfigured link so views render nothing rather than a dead link.
export function funraiseLinks(config: Config): FunraiseLinkUrls {
  const resolve = (value: string): string | null =>
    value === FUNRAISE_URL_PLACEHOLDER || value === '' ? null : value;
  return {
    manageRecurringUrl: resolve(config.funraise.manageRecurringUrl),
    renewMembershipUrl: resolve(config.funraise.renewMembershipUrl),
  };
}

export function pledgesEnabled(config: Config): boolean {
  const p = config.pledges;
  if (p.boardId === null) return false;
  // Derived from REQUIRED_PLEDGE_COLUMNS rather than a second hand-maintained list, so adding
  // a column later can't accidentally enable the feature with that column still a placeholder.
  return REQUIRED_PLEDGE_COLUMNS.every((key) => p.columns[key] !== PLACEHOLDER_COLUMN_VALUE);
}

// The EIN once sign-off has replaced its placeholder, else null — the matching-gifts page
// shows it to donors filling in employer matching forms. Lives here beside the other gates so
// the SIGNOFF_PLACEHOLDER sentinel never leaks into route code as a second string literal.
export function signedOffEin(config: Config): string | null {
  const ein = config.taxLetter.ein;
  return ein !== SIGNOFF_PLACEHOLDER && ein.length > 0 ? ein : null;
}

// Gates only the embedded employer-search widget — the matching-gifts page itself always
// renders (its generic "ask your HR team" guidance is useful with no vendor at all).
export function matchingGiftsSearchEnabled(config: Config): boolean {
  const key = config.matchingGifts.doubleTheDonationPublicKey;
  return key !== null && key.length > 0;
}
