import type { Config, MondayColumns } from './types';

const REQUIRED_TOP_LEVEL = ['monday', 'resend', 'auth', 'rateLimit', 'taxLetter', 'changeRequests'] as const;

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

const PLACEHOLDER_COLUMN_VALUE = 'REPLACE_WITH_COLUMN_ID';
const SIGNOFF_PLACEHOLDER = 'REPLACE_AFTER_SIGNOFF';

const REQUIRED_RESEND_KEYS = ['fromAddress', 'fromName'] as const;
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
  const columns = requireObject(monday, 'columns');
  requireKeys(columns, 'monday.columns', REQUIRED_COLUMNS);
  requireNoPlaceholderColumns(columns);
  requireKeys(columns, 'monday.columns', V2_DONOR_COLUMNS);
  requireKeys(columns, 'monday.columns', CARD_COLUMNS);

  const resend = requireObject(cfg, 'resend');
  requireKeys(resend, 'resend', REQUIRED_RESEND_KEYS);

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

export function cardEnabled(config: Config): boolean {
  return config.monday.columns.membershipExpiry !== PLACEHOLDER_COLUMN_VALUE;
}
