import type { FunraiseSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations:live', 'recurring-gifts', 'people-live'] as const;

const REQUIRED_FUNRAISE_SYNC_KEYS = [
  'itemNameField',
  'entityIdField',
  'donorExternalIdField',
  'donorExternalIdColumn',
  'donorEmailColumn',
  'donorNameField',
  'donorFirstNameField',
  'donorLastNameField',
  'donorFirstNameColumn',
  'donorLastNameColumn',
  'donorLinkColumn',
  'emailFieldPrecedence',
  'statusField',
  'statusValueMap',
  'doNotMigrateFields',
] as const;

// Column ids the consumer stamps itself (not via columnMap). Each must be present so a fork
// opts out deliberately with null rather than by forgetting the key.
const NULLABLE_COLUMN_KEYS = {
  entityIdColumn: 'orphan recovery',
  thankYouSentColumn: 'the Thank You Sent stamp',
  giftTypeColumn: 'the Gift Type stamp',
  fiscalYearColumn: 'the Fiscal Year Ending stamp',
  recurringGiftLinkColumn: 'the Recurring Gift link',
} as const;

const RECURRING_GIFT_COLUMN_KEYS = [
  'funraiseId',
  'donor',
  'installmentAmount',
  'annualizedValue',
  'frequency',
  'status',
  'nextPayment',
  'designation',
  'companyMatch',
  'matchEmployer',
] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

function requireNullableColumnId(value: unknown, present: boolean, path: string, purpose: string): void {
  if (!present || (value !== null && !isNonEmptyString(value))) {
    throw new Error(`config: "${path}" must be a Monday column id string, or null to disable ${purpose}`);
  }
}

export function validateConfig(raw: unknown): FunraiseSyncConfig {
  if (!isObject(raw)) {
    throw new Error('config: expected an object');
  }
  const cfg = raw;

  if (!isObject(cfg.monday)) {
    throw new Error('config: missing required key "monday"');
  }
  const monday = cfg.monday;

  if (!isNonEmptyString(monday.apiUrl)) {
    throw new Error('config: missing required key "monday.apiUrl"');
  }

  if (!isObject(monday.boards)) {
    throw new Error('config: missing required key "monday.boards"');
  }
  for (const key of REQUIRED_BOARD_KEYS) {
    if (!(key in monday.boards)) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
    const id = monday.boards[key];
    if (id !== null && (typeof id !== 'number' || !Number.isInteger(id))) {
      throw new Error(`config: "monday.boards.${key}" must be a Monday board id number, or null when unconfigured`);
    }
  }

  if (!isObject(cfg.funraiseSync)) {
    throw new Error('config: missing required key "funraiseSync"');
  }
  const funraiseSync = cfg.funraiseSync;

  for (const key of REQUIRED_FUNRAISE_SYNC_KEYS) {
    if (!(key in funraiseSync)) {
      throw new Error(`config: missing required key "funraiseSync.${key}"`);
    }
  }

  // One entity type since 2026-09-18: columnMap is a flat Funraise-field-path → column-id map.
  // The old per-entity shape ({ transaction: {…}, … }) fails here on its nested value, so a fork
  // carrying the pre-decision config is told exactly which key to flatten.
  if (!isObject(funraiseSync.columnMap)) {
    throw new Error('config: missing required key "funraiseSync.columnMap"');
  }
  for (const [funraiseField, columnId] of Object.entries(funraiseSync.columnMap)) {
    if (!isNonEmptyString(columnId)) {
      throw new Error(`config: "funraiseSync.columnMap.${funraiseField}" must be a Monday column id string`);
    }
  }

  for (const key of [
    'itemNameField',
    'entityIdField',
    'donorExternalIdField',
    'donorExternalIdColumn',
    'donorEmailColumn',
    'donorNameField',
    'donorFirstNameField',
    'donorLastNameField',
    'donorFirstNameColumn',
    'donorLastNameColumn',
    'donorLinkColumn',
    'statusField',
  ] as const) {
    if (!isNonEmptyString(funraiseSync[key])) {
      throw new Error(`config: "funraiseSync.${key}" must be a non-empty string`);
    }
  }

  const emailFieldPrecedence = funraiseSync.emailFieldPrecedence;
  if (
    !Array.isArray(emailFieldPrecedence) ||
    emailFieldPrecedence.length === 0 ||
    emailFieldPrecedence.some((f) => !isNonEmptyString(f))
  ) {
    throw new Error('config: "funraiseSync.emailFieldPrecedence" must be a non-empty array of field paths');
  }

  const statusValueMap = funraiseSync.statusValueMap;
  if (!isObject(statusValueMap) || Object.values(statusValueMap).some((v) => typeof v !== 'string')) {
    throw new Error('config: "funraiseSync.statusValueMap" must map status strings to status strings');
  }

  const doNotMigrateFields = funraiseSync.doNotMigrateFields;
  if (!Array.isArray(doNotMigrateFields) || doNotMigrateFields.some((f) => typeof f !== 'string')) {
    throw new Error('config: "funraiseSync.doNotMigrateFields" must be an array of field paths');
  }

  for (const [key, purpose] of Object.entries(NULLABLE_COLUMN_KEYS)) {
    requireNullableColumnId(funraiseSync[key], key in funraiseSync, `funraiseSync.${key}`, purpose);
  }

  if (funraiseSync.giftTypeColumn !== null) {
    for (const key of ['giftTypeValue', 'eventGiftTypeValue'] as const) {
      if (!isNonEmptyString(funraiseSync[key])) {
        throw new Error(`config: "funraiseSync.${key}" must be a non-empty Gift Type label when giftTypeColumn is set`);
      }
    }
  }

  const oldestActiveFiscalYear = funraiseSync.oldestActiveFiscalYear;
  if (
    oldestActiveFiscalYear !== null &&
    (typeof oldestActiveFiscalYear !== 'number' || !Number.isInteger(oldestActiveFiscalYear) || oldestActiveFiscalYear <= 0)
  ) {
    throw new Error('config: "funraiseSync.oldestActiveFiscalYear" must be a fiscal year (e.g. 2026) or null to disable the archived-gift check');
  }

  for (const key of ['rawPayloadRetentionDays', 'unresolvedPayloadRetentionDays'] as const) {
    if (typeof funraiseSync[key] !== 'number' || (funraiseSync[key] as number) <= 0) {
      throw new Error(`config: "funraiseSync.${key}" must be a positive number of days`);
    }
  }

  // Subscriptions poller (spec 2026-09-18).
  if (!isObject(cfg.subscriptionsPoll)) {
    throw new Error('config: missing required key "subscriptionsPoll"');
  }
  const poll = cfg.subscriptionsPoll;
  if (typeof poll.enabled !== 'boolean') {
    throw new Error('config: "subscriptionsPoll.enabled" must be a boolean');
  }
  if (!isObject(poll.columns)) {
    throw new Error('config: missing required key "subscriptionsPoll.columns"');
  }
  for (const key of RECURRING_GIFT_COLUMN_KEYS) {
    requireNullableColumnId(poll.columns[key], key in poll.columns, `subscriptionsPoll.columns.${key}`, 'that column');
  }
  if (
    !isObject(poll.frequencyMultiplier) ||
    Object.values(poll.frequencyMultiplier).some((v) => typeof v !== 'number' || !(v > 0))
  ) {
    throw new Error('config: "subscriptionsPoll.frequencyMultiplier" must map frequency labels to positive numbers');
  }
  if (!isObject(poll.statusLabelMap) || Object.values(poll.statusLabelMap).some((v) => typeof v !== 'string')) {
    throw new Error('config: "subscriptionsPoll.statusLabelMap" must map Funraise statuses to board labels');
  }
  if (typeof poll.maxPagesPerRun !== 'number' || !Number.isInteger(poll.maxPagesPerRun) || poll.maxPagesPerRun < 1) {
    throw new Error('config: "subscriptionsPoll.maxPagesPerRun" must be a positive integer (1 on Workers Free: 50 external subrequests per invocation)');
  }
  if (!isNonEmptyString(poll.funraiseLinkBase)) {
    throw new Error('config: "subscriptionsPoll.funraiseLinkBase" must be a non-empty URL prefix');
  }

  return cfg as unknown as FunraiseSyncConfig;
}
