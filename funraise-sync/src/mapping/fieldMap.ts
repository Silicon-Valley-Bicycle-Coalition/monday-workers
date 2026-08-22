import type { EntityType, FunraiseSyncConfig } from '../types';
import { getPath } from '../util/getPath';

type ColumnMapKey = keyof FunraiseSyncConfig['funraiseSync']['columnMap'];

export const ENTITY_MAP_KEY: Record<EntityType, ColumnMapKey> = {
  transaction: 'transaction',
  subscription: 'recurringGift',
  pledge: 'recurringGift',
  registration: 'registration',
};

export function mapToMondayColumns(
  entityType: EntityType,
  rawPayload: Record<string, unknown>,
  config: FunraiseSyncConfig
): Record<string, unknown> {
  const mapKey = ENTITY_MAP_KEY[entityType];
  const { columnMap, doNotMigrateFields, statusField, statusValueMap } = config.funraiseSync;
  const fields = columnMap[mapKey];

  const result: Record<string, unknown> = {};
  for (const [funraiseField, mondayColumnId] of Object.entries(fields)) {
    if (doNotMigrateFields.includes(funraiseField)) continue;

    let value = getPath(rawPayload, funraiseField);
    if (value === undefined) continue;

    if (funraiseField === statusField && typeof value === 'string') {
      value = statusValueMap[value] ?? value;
    }

    result[mondayColumnId] = value;
  }
  return result;
}
