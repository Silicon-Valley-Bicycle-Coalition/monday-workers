import type { FunraiseSyncConfig } from '../types';
import { getPath } from '../util/getPath';

// Funraise transaction (the delivery's `data`) → Donations column values, verbatim except for
// the status label map. Fields on the do-not-migrate list never leave here even if a column is
// mapped for them, so a config mistake can't leak card data.
export function mapToMondayColumns(
  rawPayload: Record<string, unknown>,
  config: FunraiseSyncConfig
): Record<string, unknown> {
  const { columnMap, doNotMigrateFields, statusField, statusValueMap } = config.funraiseSync;

  const result: Record<string, unknown> = {};
  for (const [funraiseField, mondayColumnId] of Object.entries(columnMap)) {
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
