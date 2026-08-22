import type { FunraiseSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations:live', 'recurring-gifts', 'event-registrations', 'people-live'] as const;

const REQUIRED_FUNRAISE_SYNC_KEYS = [
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

  return cfg as unknown as FunraiseSyncConfig;
}
