import type { Config, MondayColumns, PrefField } from './types';

const REQUIRED_TOP_LEVEL = [
  'monday',
  'email',
  'auth',
  'rateLimit',
  'taxLetter',
  'changeRequests',
  'cardTokens',
  'volunteerHistory',
  'pledges',
  'matchingGifts',
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

// COMM_PREF_COLUMNS deliberately isn't merged into REQUIRED_COLUMNS: each column only matters to
// the communication-preferences feature, which is gated per column (configuredPrefFields), not
// deploy-blocking. Checked for *presence* only, not placeholder-freedom — same treatment as
// V2_DONOR_COLUMNS.
const COMM_PREF_COLUMNS: (keyof MondayColumns)[] = ['donorEmailOptOut', 'donorSmsOptOut', 'donorDoNotMail'];

// Which Donors-board checkbox column backs each preference field. Also fixes the order the
// preferences render in on the change-request form.
export const PREF_FIELD_COLUMNS: Record<PrefField, keyof MondayColumns> = {
  emailOptOut: 'donorEmailOptOut',
  smsOptOut: 'donorSmsOptOut',
  doNotMail: 'donorDoNotMail',
};

const PLACEHOLDER_COLUMN_VALUE = 'REPLACE_WITH_COLUMN_ID';
const SIGNOFF_PLACEHOLDER = 'REPLACE_AFTER_SIGNOFF';

const REQUIRED_EMAIL_KEYS = ['fromAddress', 'fromName'] as const;
const REQUIRED_AUTH_KEYS = ['magicLinkTtlMinutes', 'sessionTtlHours', 'portalBaseUrl'] as const;
const REQUIRED_RATE_LIMIT_KEYS = ['emailWindowSeconds', 'emailMaxAttempts'] as const;
const REQUIRED_TAX_LETTER_KEYS = [
  'orgLegalName',
  'ein',
  'orgAddress',
  'signatureName',
  'signatureTitle',
  'plainStatement',
  'benefitStatement',
  'benefitTiers',
] as const;
const REQUIRED_CHANGE_REQUEST_KEYS = ['boardId', 'columns', 'dedupeWindowHours', 'retentionDays'] as const;
const REQUIRED_CHANGE_REQUEST_COLUMNS = ['donorLink', 'field', 'oldValue', 'newValue', 'submittedAt'] as const;
const REQUIRED_CARD_TOKENS_KEYS = ['retentionDays'] as const;
const REQUIRED_VOLUNTEER_HISTORY_KEYS = ['completedStatuses'] as const;
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
  requireKeys(columns, 'monday.columns', COMM_PREF_COLUMNS);

  const email = requireObject(cfg, 'email');
  requireKeys(email, 'email', REQUIRED_EMAIL_KEYS);

  const auth = requireObject(cfg, 'auth');
  requireKeys(auth, 'auth', REQUIRED_AUTH_KEYS);

  const rateLimit = requireObject(cfg, 'rateLimit');
  requireKeys(rateLimit, 'rateLimit', REQUIRED_RATE_LIMIT_KEYS);

  const taxLetter = requireObject(cfg, 'taxLetter');
  requireKeys(taxLetter, 'taxLetter', REQUIRED_TAX_LETTER_KEYS);

  const changeRequests = requireObject(cfg, 'changeRequests');
  requireKeys(changeRequests, 'changeRequests', REQUIRED_CHANGE_REQUEST_KEYS);
  const crColumns = requireObject(changeRequests, 'columns', 'changeRequests.columns');
  requireKeys(crColumns, 'changeRequests.columns', REQUIRED_CHANGE_REQUEST_COLUMNS);
  if (typeof changeRequests.retentionDays !== 'number' || changeRequests.retentionDays <= 0) {
    throw new Error('config: "changeRequests.retentionDays" must be a positive number of days');
  }

  const cardTokens = requireObject(cfg, 'cardTokens');
  requireKeys(cardTokens, 'cardTokens', REQUIRED_CARD_TOKENS_KEYS);
  if (typeof cardTokens.retentionDays !== 'number' || cardTokens.retentionDays <= 0) {
    throw new Error('config: "cardTokens.retentionDays" must be a positive number of days');
  }

  const volunteerHistory = requireObject(cfg, 'volunteerHistory');
  requireKeys(volunteerHistory, 'volunteerHistory', REQUIRED_VOLUNTEER_HISTORY_KEYS);
  const completedStatuses = volunteerHistory.completedStatuses;
  if (!Array.isArray(completedStatuses) || completedStatuses.some((s) => typeof s !== 'string')) {
    throw new Error('config: "volunteerHistory.completedStatuses" must be an array of strings');
  }

  // Both gated (pledgesEnabled / matchingGiftsSearchEnabled), not deploy-blocking — presence
  // checks only, same treatment as changeRequests' columns.
  const pledges = requireObject(cfg, 'pledges');
  requireKeys(pledges, 'pledges', REQUIRED_PLEDGES_KEYS);
  const pledgeColumns = requireObject(pledges, 'columns', 'pledges.columns');
  requireKeys(pledgeColumns, 'pledges.columns', REQUIRED_PLEDGE_COLUMNS);

  const matchingGifts = requireObject(cfg, 'matchingGifts');
  requireKeys(matchingGifts, 'matchingGifts', REQUIRED_MATCHING_GIFTS_KEYS);

  return cfg as unknown as Config;
}

export function lettersEnabled(config: Config): boolean {
  const t = config.taxLetter;
  const strings = [
    t.orgLegalName,
    t.ein,
    t.orgAddress,
    t.signatureName,
    t.signatureTitle,
    t.plainStatement,
    t.benefitStatement,
  ];
  return strings.every((s) => s !== SIGNOFF_PLACEHOLDER && s.length > 0);
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

export function cardEnabled(config: Config): boolean {
  return config.monday.columns.membershipExpiry !== PLACEHOLDER_COLUMN_VALUE;
}

export function volunteerHistoryEnabled(config: Config): boolean {
  // typeof check (not === null) so a missing/undefined or mistyped board id counts as disabled
  // rather than enabled-against-board-0.
  if (typeof config.monday.volunteersBoardId !== 'number') return false;
  return VOLUNTEER_COLUMNS.every((key) => config.monday.columns[key] !== PLACEHOLDER_COLUMN_VALUE);
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
