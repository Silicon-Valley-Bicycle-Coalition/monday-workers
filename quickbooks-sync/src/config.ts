import type { QuickbooksSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['customers', 'invoices', 'products'] as const;
const REQUIRED_QUICKBOOKS_SYNC_KEYS = [
  'columnMap',
  'itemNameField',
  'linkColumn',
  'customerCreateFieldMap',
  'customerQbIdColumn',
] as const;
const REQUIRED_ENTITY_KEYS = ['customer', 'invoice', 'product'] as const;

// Every nested object is unwrapped through this, so a non-object where an object is required
// reads the same as an outright missing key.
function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`config: missing required key "${path}"`);
  }
  return value as Record<string, unknown>;
}

export function validateConfig(raw: unknown): QuickbooksSyncConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  const monday = requireObject(cfg.monday, 'monday');

  if (typeof monday.apiUrl !== 'string') {
    throw new Error('config: "monday.apiUrl" must be a string');
  }

  const boards = requireObject(monday.boards, 'monday.boards');
  for (const key of REQUIRED_BOARD_KEYS) {
    if (!(key in boards)) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
    // Load-bearing, not cosmetic: the Monday webhook route compares an incoming numeric boardId
    // against this value with ===. A board id typo'd as a string would never match, silently
    // dropping every Monday event as "wrong board" with no error anywhere.
    const boardId = boards[key];
    if (boardId !== null && typeof boardId !== 'number') {
      throw new Error(`config: "monday.boards.${key}" must be a number or null`);
    }
  }

  const quickbooks = requireObject(cfg.quickbooks, 'quickbooks');
  if (typeof quickbooks.apiBaseUrl !== 'string' || !/^https:\/\/[^/]+\/v3\/company$/.test(quickbooks.apiBaseUrl)) {
    throw new Error('config: "quickbooks.apiBaseUrl" must be an https URL ending in /v3/company (the QuickBooks Accounting API base)');
  }

  const quickbooksSync = requireObject(cfg.quickbooksSync, 'quickbooksSync');

  for (const key of REQUIRED_QUICKBOOKS_SYNC_KEYS) {
    if (!(key in quickbooksSync)) {
      throw new Error(`config: missing required key "quickbooksSync.${key}"`);
    }
  }

  const qbIdColumn = quickbooksSync.customerQbIdColumn;
  if (qbIdColumn !== null && (typeof qbIdColumn !== 'string' || qbIdColumn === '')) {
    throw new Error('config: "quickbooksSync.customerQbIdColumn" must be a Monday column id or null');
  }

  const columnMap = requireObject(quickbooksSync.columnMap, 'quickbooksSync.columnMap');
  for (const key of REQUIRED_ENTITY_KEYS) {
    if (!(key in columnMap)) {
      throw new Error(`config: missing required key "quickbooksSync.columnMap.${key}"`);
    }
  }

  const itemNameField = requireObject(quickbooksSync.itemNameField, 'quickbooksSync.itemNameField');
  for (const key of REQUIRED_ENTITY_KEYS) {
    if (!(key in itemNameField)) {
      throw new Error(`config: missing required key "quickbooksSync.itemNameField.${key}"`);
    }
  }

  return cfg as unknown as QuickbooksSyncConfig;
}
