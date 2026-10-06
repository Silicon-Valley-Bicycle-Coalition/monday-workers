import type { EventbriteSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations:live', 'people-live'] as const;

// The placeholder config/svbc.json ships with, and config/sandbox.json's orderIdColumn carries
// until the Eventbrite Order ID column exists (README "Prerequisite column"). Validation accepts
// it — production config is allowed to be unconfigured — and the consumer refuses to write on it.
export const PLACEHOLDER_COLUMN_ID = 'REPLACE_WITH_COLUMN_ID';

const REQUIRED_COLUMN_KEYS = ['orderIdColumn', 'amountColumn', 'statusColumn', 'dateColumn', 'donorEmailColumn', 'donorLinkColumn'] as const;

// Column ids the consumer stamps on first write only. Each must be present so a fork opts out
// deliberately with null rather than by forgetting the key.
const NULLABLE_COLUMN_KEYS = {
  thankYouSentColumn: 'the Thank You Sent stamp',
  giftTypeColumn: 'the Gift Type stamp',
  fiscalYearColumn: 'the Fiscal Year Ending stamp',
} as const;

const AMOUNT_SOURCES = ['gross', 'base_price'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

export function validateConfig(raw: unknown): EventbriteSyncConfig {
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

  if (!isObject(cfg.eventbrite)) {
    throw new Error('config: missing required key "eventbrite"');
  }
  const eventbrite = cfg.eventbrite;
  if (!isNonEmptyString(eventbrite.apiUrl) || !/^https:\/\/[^/]+\/v3$/.test(eventbrite.apiUrl)) {
    throw new Error('config: "eventbrite.apiUrl" must be an https URL ending in /v3 with no trailing slash');
  }
  if (eventbrite.organizationId !== null && !isNonEmptyString(eventbrite.organizationId)) {
    throw new Error('config: "eventbrite.organizationId" must be the organization id as a string, or null to skip the check');
  }
  if (!Array.isArray(eventbrite.actions) || eventbrite.actions.length === 0 || eventbrite.actions.some((a) => !/^[a-z_]+\.[a-z_]+$/.test(String(a)))) {
    throw new Error('config: "eventbrite.actions" must be a non-empty array of webhook actions such as "order.placed"');
  }

  if (!isObject(cfg.eventbriteSync)) {
    throw new Error('config: missing required key "eventbriteSync"');
  }
  const sync = cfg.eventbriteSync;
  for (const key of REQUIRED_COLUMN_KEYS) {
    if (!isNonEmptyString(sync[key])) {
      throw new Error(`config: "eventbriteSync.${key}" must be a Monday column id string`);
    }
  }
  for (const [key, purpose] of Object.entries(NULLABLE_COLUMN_KEYS)) {
    if (!(key in sync) || (sync[key] !== null && !isNonEmptyString(sync[key]))) {
      throw new Error(`config: "eventbriteSync.${key}" must be a Monday column id string, or null to disable ${purpose}`);
    }
  }
  if (sync.giftTypeColumn !== null && !isNonEmptyString(sync.giftTypeValue)) {
    throw new Error('config: "eventbriteSync.giftTypeValue" must be a non-empty Gift Type label when giftTypeColumn is set');
  }
  if (!AMOUNT_SOURCES.includes(sync.amountSource as (typeof AMOUNT_SOURCES)[number])) {
    throw new Error(`config: "eventbriteSync.amountSource" must be one of ${AMOUNT_SOURCES.join(', ')}`);
  }
  if (typeof sync.skipFreeOrders !== 'boolean') {
    throw new Error('config: "eventbriteSync.skipFreeOrders" must be a boolean');
  }
  const statusLabelMap = sync.statusLabelMap;
  if (!isObject(statusLabelMap) || Object.keys(statusLabelMap).length === 0 || Object.values(statusLabelMap).some((v) => !isNonEmptyString(v))) {
    throw new Error('config: "eventbriteSync.statusLabelMap" must map Eventbrite order statuses to Donations Status labels');
  }
  if (!isNonEmptyString(sync.itemNameTemplate)) {
    throw new Error('config: "eventbriteSync.itemNameTemplate" must be a non-empty template such as "{buyer} - {event}"');
  }

  return cfg as unknown as EventbriteSyncConfig;
}
