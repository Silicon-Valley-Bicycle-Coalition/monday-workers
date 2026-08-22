import type { QuickbooksSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['customers', 'invoices', 'products'] as const;
const REQUIRED_QUICKBOOKS_SYNC_KEYS = [
  'columnMap',
  'itemNameField',
  'linkColumn',
  'customerCreateFieldMap',
] as const;
const REQUIRED_ENTITY_KEYS = ['customer', 'invoice', 'product'] as const;

export function validateConfig(raw: unknown): QuickbooksSyncConfig {
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

  if (typeof cfg.quickbooksSync !== 'object' || cfg.quickbooksSync === null) {
    throw new Error('config: missing required key "quickbooksSync"');
  }
  const quickbooksSync = cfg.quickbooksSync as Record<string, unknown>;

  for (const key of REQUIRED_QUICKBOOKS_SYNC_KEYS) {
    if (!(key in quickbooksSync)) {
      throw new Error(`config: missing required key "quickbooksSync.${key}"`);
    }
  }

  if (typeof quickbooksSync.columnMap !== 'object' || quickbooksSync.columnMap === null) {
    throw new Error('config: missing required key "quickbooksSync.columnMap"');
  }
  const columnMap = quickbooksSync.columnMap as Record<string, unknown>;
  for (const key of REQUIRED_ENTITY_KEYS) {
    if (!(key in columnMap)) {
      throw new Error(`config: missing required key "quickbooksSync.columnMap.${key}"`);
    }
  }

  if (typeof quickbooksSync.itemNameField !== 'object' || quickbooksSync.itemNameField === null) {
    throw new Error('config: missing required key "quickbooksSync.itemNameField"');
  }
  const itemNameField = quickbooksSync.itemNameField as Record<string, unknown>;
  for (const key of REQUIRED_ENTITY_KEYS) {
    if (!(key in itemNameField)) {
      throw new Error(`config: missing required key "quickbooksSync.itemNameField.${key}"`);
    }
  }

  return cfg as unknown as QuickbooksSyncConfig;
}
