import type { EntityType, QuickbooksSyncConfig } from '../types';

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof cursor[key] !== 'object' || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function mapQbToMondayColumns(
  entityType: EntityType,
  qbRecord: Record<string, unknown>,
  config: QuickbooksSyncConfig
): Record<string, unknown> {
  const fields = config.quickbooksSync.columnMap[entityType];
  const result: Record<string, unknown> = {};
  for (const [qbField, mondayColumnId] of Object.entries(fields)) {
    const value = getPath(qbRecord, qbField);
    if (value === undefined) continue;
    result[mondayColumnId] = value;
  }
  return result;
}

export function mapMondayToQbCustomerFields(
  mondayColumnValues: Record<string, unknown>,
  config: QuickbooksSyncConfig
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [mondayColumnId, qbField] of Object.entries(config.quickbooksSync.customerCreateFieldMap)) {
    const value = mondayColumnValues[mondayColumnId];
    if (value === undefined) continue;
    setPath(result, qbField, value);
  }
  return result;
}
