import type { Config, ConsentConfig, JourneyInterestsConfig, DonorColumnsConfig, HistoricalBoardConfig, MondayColumnsConfig, MailchimpMergeFieldsConfig, MailchimpTagsConfig } from './types';

const REQUIRED_TOP_LEVEL = ['monday', 'mailchimp', 'lifetimeTierValue', 'activeStatusValue', 'dnsConfirmedValue', 'consent'] as const;

const REQUIRED_DONOR_COLUMNS: (keyof DonorColumnsConfig)[] = [
  'membershipStatus', 'membershipTier', 'memberSince', 'memberUntil',
  'addr1', 'city', 'zip', 'email', 'totalGiven',
  'doNotSolicit', 'dnsReasonStatus',
];

const REQUIRED_MONDAY_COLUMNS: (keyof MondayColumnsConfig)[] = [...REQUIRED_DONOR_COLUMNS, 'mailchimpCampaigns'];

const REQUIRED_MERGE_FIELDS: (keyof MailchimpMergeFieldsConfig)[] = [
  'memberSince', 'memberUntil', 'membershipTier', 'membershipStatus', 'address', 'totalGiven',
];

const REQUIRED_TAGS: (keyof MailchimpTagsConfig)[] = [
  'activeMember', 'lapsedMember', 'lifetimeMember', 'hasDonated', 'doNotSolicit', 'recurringDonor',
];

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${path}"`);
  }
  return value as Record<string, unknown>;
}

function requireStringKeys(obj: Record<string, unknown>, keys: readonly string[], prefix: string): void {
  for (const key of keys) {
    if (typeof obj[key] !== 'string' || obj[key] === '') {
      throw new Error(`config: missing required key "${prefix}.${key}"`);
    }
  }
}

function numberOrNull(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') {
    throw new Error(`config: "${path}" must be a number or null`);
  }
  return value;
}

function requireNullableColumns(columns: Record<string, unknown>, prefix: string): void {
  // Explicit null says "this board has no State column" (production People): the ADDRESS merge
  // field then takes the state from the ZIP. The placeholder is rejected rather than queried:
  // Monday silently drops an unknown column id, which left every ADDRESS unwritten.
  if (columns.state !== null && (typeof columns.state !== 'string' || columns.state === '' || columns.state === 'REPLACE_WITH_COLUMN_ID')) {
    throw new Error(`config: "${prefix}.state" must be a column id or null`);
  }
  // Explicit null (not an absent key) says "this deployment has no Nearby column yet".
  if (columns.nearby !== null && (typeof columns.nearby !== 'string' || columns.nearby === '')) {
    throw new Error(`config: "${prefix}.nearby" must be a column id or null`);
  }
  // Optional: absent or null means the recurring-donor tag is not synced from this board.
  const recurring = columns.hasActiveRecurringGift;
  if (recurring !== undefined && recurring !== null && (typeof recurring !== 'string' || recurring === '')) {
    throw new Error(`config: "${prefix}.hasActiveRecurringGift" must be a column id or null`);
  }
}

function historicalBoard(value: unknown, donorsBoardId: number | null): HistoricalBoardConfig | null {
  if (value === null || value === undefined) return null;
  const board = requireObject(value, 'monday.historical');
  if (typeof board.boardId !== 'number') {
    throw new Error('config: "monday.historical.boardId" must be a number');
  }
  // The consumer asks People whether it holds an address before a Historical item may write it.
  if (donorsBoardId === null) {
    throw new Error('config: "monday.historical" needs "monday.donorsBoardId" set');
  }
  const columns = requireObject(board.columns, 'monday.historical.columns');
  requireStringKeys(columns, REQUIRED_DONOR_COLUMNS, 'monday.historical.columns');
  requireNullableColumns(columns, 'monday.historical.columns');
  return { boardId: board.boardId, columns: columns as unknown as DonorColumnsConfig };
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

// Optional: absent or null turns the feature off. Each interest id may be null on its own.
function journeyInterestsConfig(value: unknown): JourneyInterestsConfig | null {
  if (value === undefined || value === null) return null;
  const obj = requireObject(value, 'mailchimp.journeyInterests');
  const id = (key: string): string | null => {
    const v = obj[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' || v === '') throw new Error(`config: "mailchimp.journeyInterests.${key}" must be an interest id or null`);
    return v;
  };
  if (typeof obj.renewalOptOutTag !== 'string' || obj.renewalOptOutTag === '') {
    throw new Error('config: missing required key "mailchimp.journeyInterests.renewalOptOutTag"');
  }
  return { welcomeDrip: id('welcomeDrip'), renewalReminders: id('renewalReminders'), renewalOptOutTag: obj.renewalOptOutTag };
}

function consentConfig(value: unknown): ConsentConfig {
  const consent = requireObject(value, 'consent');
  if (typeof consent.enabled !== 'boolean') throw new Error('config: "consent.enabled" must be true or false');
  const max = consent.maxChangesPerRun;
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
    throw new Error('config: "consent.maxChangesPerRun" must be a positive integer');
  }
  if (!Array.isArray(consent.boards) || consent.boards.length === 0) {
    throw new Error('config: "consent.boards" must be a non-empty array');
  }
  const boards = consent.boards.map((raw, i) => {
    const board = requireObject(raw, `consent.boards[${i}]`);
    if (!nonEmptyString(board.name) || typeof board.boardId !== 'number') {
      throw new Error(`config: "consent.boards[${i}]" needs a name and a numeric boardId`);
    }
    if (!Array.isArray(board.pairs) || board.pairs.length === 0) {
      throw new Error(`config: "consent.boards[${i}].pairs" must be a non-empty array`);
    }
    const pairs = board.pairs.map((p, j) => {
      const pair = requireObject(p, `consent.boards[${i}].pairs[${j}]`);
      if (!nonEmptyString(pair.emailColumn) || !nonEmptyString(pair.consentColumn)) {
        throw new Error(`config: "consent.boards[${i}].pairs[${j}]" needs emailColumn and consentColumn ids`);
      }
      return { emailColumn: pair.emailColumn, consentColumn: pair.consentColumn };
    });
    return { name: board.name, boardId: board.boardId, pairs };
  });
  return { enabled: consent.enabled, maxChangesPerRun: max, boards };
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

  const monday = requireObject(cfg.monday, 'monday');
  if (typeof monday.apiUrl !== 'string' || monday.apiUrl === '') {
    throw new Error('config: missing required key "monday.apiUrl"');
  }
  const columns = requireObject(monday.columns, 'monday.columns');
  requireStringKeys(columns, REQUIRED_MONDAY_COLUMNS, 'monday.columns');
  requireNullableColumns(columns, 'monday.columns');
  const donorsBoardId = numberOrNull(monday.donorsBoardId, 'monday.donorsBoardId');

  const mailchimp = requireObject(cfg.mailchimp, 'mailchimp');
  if (typeof mailchimp.apiBaseUrl !== 'string' || mailchimp.apiBaseUrl === '') {
    throw new Error('config: missing required key "mailchimp.apiBaseUrl"');
  }
  if (typeof mailchimp.audienceId !== 'string' || mailchimp.audienceId === '') {
    throw new Error('config: missing required key "mailchimp.audienceId"');
  }
  const mergeFields = requireObject(mailchimp.mergeFields, 'mailchimp.mergeFields');
  requireStringKeys(mergeFields, REQUIRED_MERGE_FIELDS, 'mailchimp.mergeFields');
  const tags = requireObject(mailchimp.tags, 'mailchimp.tags');
  requireStringKeys(tags, REQUIRED_TAGS, 'mailchimp.tags');
  if (typeof mailchimp.nearbyTagPrefix !== 'string' || mailchimp.nearbyTagPrefix === '') {
    throw new Error('config: missing required key "mailchimp.nearbyTagPrefix"');
  }
  const categoryIds = mailchimp.interestCategoryIds;
  if (!Array.isArray(categoryIds) || categoryIds.length === 0
    || !categoryIds.every((id) => typeof id === 'string' && id !== '')) {
    throw new Error('config: "mailchimp.interestCategoryIds" must be a non-empty array of category ids');
  }

  if (typeof cfg.lifetimeTierValue !== 'string' || cfg.lifetimeTierValue === '') {
    throw new Error('config: missing required key "lifetimeTierValue"');
  }
  if (typeof cfg.activeStatusValue !== 'string' || cfg.activeStatusValue === '') {
    throw new Error('config: missing required key "activeStatusValue"');
  }
  if (typeof cfg.dnsConfirmedValue !== 'string' || cfg.dnsConfirmedValue === '') {
    throw new Error('config: missing required key "dnsConfirmedValue"');
  }

  return {
    monday: {
      apiUrl: monday.apiUrl,
      donorsBoardId,
      campaignsBoardId: numberOrNull(monday.campaignsBoardId, 'monday.campaignsBoardId'),
      columns: columns as unknown as MondayColumnsConfig,
      historical: historicalBoard(monday.historical, donorsBoardId),
    },
    mailchimp: {
      apiBaseUrl: mailchimp.apiBaseUrl,
      audienceId: mailchimp.audienceId,
      mergeFields: mergeFields as unknown as MailchimpMergeFieldsConfig,
      tags: tags as unknown as MailchimpTagsConfig,
      nearbyTagPrefix: mailchimp.nearbyTagPrefix,
      interestCategoryIds: categoryIds as string[],
      journeyInterests: journeyInterestsConfig(mailchimp.journeyInterests),
    },
    lifetimeTierValue: cfg.lifetimeTierValue,
    activeStatusValue: cfg.activeStatusValue,
    dnsConfirmedValue: cfg.dnsConfirmedValue,
    consent: consentConfig(cfg.consent),
  };
}
