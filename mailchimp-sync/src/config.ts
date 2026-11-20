import type { Config, ConsentConfig, EmployerAnswersConfig, JourneyInterestsConfig, JourneyLogConfig, ProfileLinksConfig, RenewalDueConfig, StewardshipConfig, DonorColumnsConfig, HistoricalBoardConfig, MondayColumnsConfig, MailchimpMergeFieldsConfig, MailchimpTagsConfig } from './types';

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
  const lastGift = columns.lastGiftAmount;
  if (lastGift !== undefined && lastGift !== null && (typeof lastGift !== 'string' || lastGift === '')) {
    throw new Error(`config: "${prefix}.lastGiftAmount" must be a column id or null`);
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

// Optional: absent or null turns the daily renewal-due tag off.
function renewalDueConfig(value: unknown): RenewalDueConfig | null {
  if (value === undefined || value === null) return null;
  const obj = requireObject(value, 'mailchimp.renewalDue');
  if (typeof obj.tag !== 'string' || obj.tag === '') throw new Error('config: missing required key "mailchimp.renewalDue.tag"');
  const days = obj.daysBefore;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 90) {
    throw new Error('config: "mailchimp.renewalDue.daysBefore" must be a whole number of days from 0 to 90');
  }
  return { tag: obj.tag, daysBefore: days };
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

const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

// Optional: absent or null turns the Journey send log off.
function journeyLogConfig(value: unknown): JourneyLogConfig | null {
  if (value === undefined || value === null) return null;
  const obj = requireObject(value, 'journeyLog');
  if (typeof obj.boardId !== 'number') throw new Error('config: "journeyLog.boardId" must be a number');
  if (!Array.isArray(obj.emailColumns) || obj.emailColumns.length === 0 || !obj.emailColumns.every(nonEmptyString)) {
    throw new Error('config: "journeyLog.emailColumns" must be a non-empty array of column ids');
  }
  if (!nonEmptyString(obj.timelineActivityId)) throw new Error('config: missing required key "journeyLog.timelineActivityId"');
  const ids = obj.journeyIds;
  if (ids !== null && ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || !ids.every(positiveInt))) {
    throw new Error('config: "journeyLog.journeyIds" must be a non-empty array of Journey ids, or null');
  }
  const last = obj.lastJourneyEmailColumn;
  if (last !== null && last !== undefined && !nonEmptyString(last)) {
    throw new Error('config: "journeyLog.lastJourneyEmailColumn" must be a column id or null');
  }
  if (!positiveInt(obj.maxEntriesPerRun)) throw new Error('config: "journeyLog.maxEntriesPerRun" must be a positive integer');
  return {
    boardId: obj.boardId,
    emailColumns: obj.emailColumns as string[],
    timelineActivityId: obj.timelineActivityId,
    journeyIds: (ids ?? null) as number[] | null,
    lastJourneyEmailColumn: (last ?? null) as string | null,
    maxEntriesPerRun: obj.maxEntriesPerRun,
  };
}

// Optional: absent or null turns the Mailchimp Profile link off.
function profileLinksConfig(value: unknown, audienceId: string): ProfileLinksConfig | null {
  if (value === undefined || value === null) return null;
  const obj = requireObject(value, 'profileLinks');
  if (typeof obj.boardId !== 'number') throw new Error('config: "profileLinks.boardId" must be a number');
  if (!nonEmptyString(obj.emailColumn) || !nonEmptyString(obj.linkColumn)) {
    throw new Error('config: "profileLinks" needs emailColumn and linkColumn ids');
  }
  if (!positiveInt(obj.maxWritesPerRun)) throw new Error('config: "profileLinks.maxWritesPerRun" must be a positive integer');
  return {
    boardId: obj.boardId, emailColumn: obj.emailColumn, linkColumn: obj.linkColumn, maxWritesPerRun: obj.maxWritesPerRun,
    preferences: preferencesConfig(obj.preferences, audienceId),
  };
}

// Optional within profileLinks. The page must be this audience's hosted profile form with no
// person in it: a link built from another audience's form would open a page that can't find them.
function preferencesConfig(value: unknown, audienceId: string): { column: string; pageUrl: string } | null {
  if (value === undefined || value === null) return null;
  const obj = requireObject(value, 'profileLinks.preferences');
  if (!nonEmptyString(obj.column)) throw new Error('config: "profileLinks.preferences.column" must be a column id');
  let url: URL;
  try {
    url = new URL(String(obj.pageUrl));
  } catch {
    throw new Error('config: "profileLinks.preferences.pageUrl" must be a URL');
  }
  const ok = url.protocol === 'https:' && url.hostname.endsWith('.list-manage.com') && url.pathname === '/profile'
    && nonEmptyString(url.searchParams.get('u')) && url.searchParams.get('id') === audienceId && !url.searchParams.has('e');
  if (!ok) {
    throw new Error(`config: "profileLinks.preferences.pageUrl" must be https://<org>.<dc>.list-manage.com/profile?u=<account>&id=${audienceId}, with no e=`);
  }
  return { column: obj.column, pageUrl: url.toString() };
}

// Optional: absent or null turns the employer-answer hand-over off.
function employerAnswersConfig(value: unknown): EmployerAnswersConfig | null {
  if (value === undefined || value === null) return null;
  const obj = requireObject(value, 'employerAnswers');
  // Mailchimp merge tags are at most 10 characters, upper-case letters, digits and underscores.
  if (typeof obj.mergeField !== 'string' || !/^[A-Z0-9_]{1,10}$/.test(obj.mergeField)) {
    throw new Error('config: "employerAnswers.mergeField" must be a merge tag (e.g. EMPLOYER)');
  }
  if (typeof obj.boardId !== 'number') throw new Error('config: "employerAnswers.boardId" must be a number');
  if (!Array.isArray(obj.emailColumns) || obj.emailColumns.length === 0 || !obj.emailColumns.every(nonEmptyString)) {
    throw new Error('config: "employerAnswers.emailColumns" must be a non-empty array of column ids');
  }
  if (!positiveInt(obj.maxAnswersPerRun)) throw new Error('config: "employerAnswers.maxAnswersPerRun" must be a positive integer');
  return { mergeField: obj.mergeField, boardId: obj.boardId, emailColumns: obj.emailColumns as string[], maxAnswersPerRun: obj.maxAnswersPerRun };
}

const STEWARDSHIP_COLUMNS = ['email', 'label', 'membershipStatus', 'membershipTier', 'memberType', 'memberSince', 'memberUntil', 'hasActiveRecurringGift', 'doNotSolicit'] as const;
const STEWARDSHIP_LABELS = ['welcomeDayAfter', 'welcome3Weeks', 'renewal3Weeks', 'renewal1Week', 'renewalDayOf'] as const;

// Optional: absent or null turns the stewardship labels off.
function stewardshipConfig(value: unknown): StewardshipConfig | null {
  if (value === undefined || value === null) return null;
  const obj = requireObject(value, 'stewardship');
  if (typeof obj.boardId !== 'number') throw new Error('config: "stewardship.boardId" must be a number');
  const columns = requireObject(obj.columns, 'stewardship.columns');
  requireStringKeys(columns, STEWARDSHIP_COLUMNS, 'stewardship.columns');
  const plan = requireObject(obj.plan, 'stewardship.plan');
  const labels = requireObject(plan.labels, 'stewardship.plan.labels');
  requireStringKeys(labels, STEWARDSHIP_LABELS, 'stewardship.plan.labels');
  // Each label enrolls in its own Sequence; two sharing one would send the same email twice over.
  if (new Set(STEWARDSHIP_LABELS.map((k) => labels[k])).size !== STEWARDSHIP_LABELS.length) {
    throw new Error('config: "stewardship.plan.labels" must all differ');
  }
  requireStringKeys(plan, ['activeStatusValue', 'lifetimeTierValue', 'newMemberTypeValue'], 'stewardship.plan');
  const catchUp = plan.catchUpDays;
  // Past 6 the 1-week window would reach the day-of one.
  if (typeof catchUp !== 'number' || !Number.isInteger(catchUp) || catchUp < 0 || catchUp > 6) {
    throw new Error('config: "stewardship.plan.catchUpDays" must be an integer from 0 to 6');
  }
  if (!nonEmptyString(obj.renewalOptOutTag)) throw new Error('config: missing required key "stewardship.renewalOptOutTag"');
  for (const key of ['renewalInterest', 'welcomeInterest'] as const) {
    if (obj[key] !== null && !nonEmptyString(obj[key])) throw new Error(`config: "stewardship.${key}" must be an interest id or null`);
  }
  if (!positiveInt(obj.maxWritesPerRun)) throw new Error('config: "stewardship.maxWritesPerRun" must be a positive integer');
  return {
    boardId: obj.boardId,
    columns: columns as unknown as StewardshipConfig['columns'],
    plan: plan as unknown as StewardshipConfig['plan'],
    renewalOptOutTag: obj.renewalOptOutTag,
    renewalInterest: obj.renewalInterest as string | null,
    welcomeInterest: obj.welcomeInterest as string | null,
    maxWritesPerRun: obj.maxWritesPerRun,
  };
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
  const lastGiftTag = mergeFields.lastGiftAmount;
  if (lastGiftTag !== undefined && lastGiftTag !== null && (typeof lastGiftTag !== 'string' || lastGiftTag === '')) {
    throw new Error('config: "mailchimp.mergeFields.lastGiftAmount" must be a merge tag or null');
  }
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
      renewalDue: renewalDueConfig(mailchimp.renewalDue),
    },
    lifetimeTierValue: cfg.lifetimeTierValue,
    activeStatusValue: cfg.activeStatusValue,
    dnsConfirmedValue: cfg.dnsConfirmedValue,
    consent: consentConfig(cfg.consent),
    journeyLog: journeyLogConfig(cfg.journeyLog),
    profileLinks: profileLinksConfig(cfg.profileLinks, mailchimp.audienceId),
    stewardship: stewardshipConfig(cfg.stewardship),
    employerAnswers: employerAnswersConfig(cfg.employerAnswers),
  };
}
