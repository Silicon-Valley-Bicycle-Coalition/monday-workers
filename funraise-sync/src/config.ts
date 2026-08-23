import type { FunraiseSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations:live', 'recurring-gifts', 'event-registrations', 'people-live'] as const;

const REQUIRED_FUNRAISE_SYNC_KEYS = [
  'itemNameField',
  'entityIdField',
  'donorExternalIdField',
  'donorExternalIdColumn',
  'donorEmailColumn',
  'donorNameField',
  'donorLinkColumn',
  'emailFieldPrecedence',
  'statusField',
  'statusValueMap',
  'doNotMigrateFields',
] as const;

const REQUIRED_COLUMN_MAP_KEYS = ['transaction', 'recurringGift', 'registration'] as const;

export function validateConfig(raw: unknown): FunraiseSyncConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  if (typeof cfg.monday !== 'object' || cfg.monday === null) {
    throw new Error('config: missing required key "monday"');
  }
  const monday = cfg.monday as Record<string, unknown>;

  if (typeof monday.apiUrl !== 'string' || monday.apiUrl === '') {
    throw new Error('config: missing required key "monday.apiUrl"');
  }

  if (typeof monday.boards !== 'object' || monday.boards === null) {
    throw new Error('config: missing required key "monday.boards"');
  }
  const boards = monday.boards as Record<string, unknown>;
  for (const key of REQUIRED_BOARD_KEYS) {
    if (!(key in boards)) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
  }

  if (typeof cfg.funraiseSync !== 'object' || cfg.funraiseSync === null) {
    throw new Error('config: missing required key "funraiseSync"');
  }
  const funraiseSync = cfg.funraiseSync as Record<string, unknown>;

  for (const key of REQUIRED_FUNRAISE_SYNC_KEYS) {
    if (!(key in funraiseSync)) {
      throw new Error(`config: missing required key "funraiseSync.${key}"`);
    }
  }

  if (typeof funraiseSync.columnMap !== 'object' || funraiseSync.columnMap === null) {
    throw new Error('config: missing required key "funraiseSync.columnMap"');
  }
  const columnMap = funraiseSync.columnMap as Record<string, unknown>;
  for (const key of REQUIRED_COLUMN_MAP_KEYS) {
    if (!(key in columnMap)) {
      throw new Error(`config: missing required key "funraiseSync.columnMap.${key}"`);
    }
  }

  for (const mapName of ['entityIdField', 'itemNameField'] as const) {
    const fieldMap = funraiseSync[mapName] as Record<string, unknown>;
    for (const key of REQUIRED_COLUMN_MAP_KEYS) {
      if (typeof fieldMap[key] !== 'string' || fieldMap[key] === '') {
        throw new Error(`config: missing required key "funraiseSync.${mapName}.${key}"`);
      }
    }
  }

  for (const key of REQUIRED_COLUMN_MAP_KEYS) {
    const fields = columnMap[key] as Record<string, unknown>;
    for (const [funraiseField, columnId] of Object.entries(fields)) {
      if (typeof columnId !== 'string' || columnId === '') {
        throw new Error(`config: "funraiseSync.columnMap.${key}.${funraiseField}" must be a Monday column id string`);
      }
    }
  }

  for (const key of [
    'donorExternalIdField',
    'donorExternalIdColumn',
    'donorEmailColumn',
    'donorNameField',
    'donorLinkColumn',
    'statusField',
  ] as const) {
    if (typeof funraiseSync[key] !== 'string' || funraiseSync[key] === '') {
      throw new Error(`config: "funraiseSync.${key}" must be a non-empty string`);
    }
  }

  const emailFieldPrecedence = funraiseSync.emailFieldPrecedence;
  if (
    !Array.isArray(emailFieldPrecedence) ||
    emailFieldPrecedence.length === 0 ||
    emailFieldPrecedence.some((f) => typeof f !== 'string' || f === '')
  ) {
    throw new Error('config: "funraiseSync.emailFieldPrecedence" must be a non-empty array of field paths');
  }

  const statusValueMap = funraiseSync.statusValueMap;
  if (
    typeof statusValueMap !== 'object' ||
    statusValueMap === null ||
    Object.values(statusValueMap).some((v) => typeof v !== 'string')
  ) {
    throw new Error('config: "funraiseSync.statusValueMap" must map status strings to status strings');
  }

  const doNotMigrateFields = funraiseSync.doNotMigrateFields;
  if (!Array.isArray(doNotMigrateFields) || doNotMigrateFields.some((f) => typeof f !== 'string')) {
    throw new Error('config: "funraiseSync.doNotMigrateFields" must be an array of field paths');
  }

  if (
    !('entityIdColumn' in funraiseSync) ||
    (funraiseSync.entityIdColumn !== null &&
      (typeof funraiseSync.entityIdColumn !== 'string' || funraiseSync.entityIdColumn === ''))
  ) {
    throw new Error('config: "funraiseSync.entityIdColumn" must be a Monday column id string, or null to disable orphan recovery');
  }

  for (const key of ['rawPayloadRetentionDays', 'unresolvedPayloadRetentionDays'] as const) {
    if (typeof funraiseSync[key] !== 'number' || (funraiseSync[key] as number) <= 0) {
      throw new Error(`config: "funraiseSync.${key}" must be a positive number of days`);
    }
  }

  return cfg as unknown as FunraiseSyncConfig;
}
