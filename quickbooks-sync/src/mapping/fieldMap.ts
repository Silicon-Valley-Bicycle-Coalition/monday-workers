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

function scalar(value: unknown): string | number | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

// Monday webhooks deliver each column value in its raw per-type shape — text `{ value }`, email
// `{ email, text }`, phone `{ phone, countryShortName }`, long text `{ text }`, date
// `{ date, time }`, status/dropdown `{ label: { text } }`, numbers `{ value }` — not as the plain
// string QuickBooks expects (#33). Reduce a value to its scalar, or undefined for empty or
// unrecognized shapes so they're left out of the create rather than sent as garbage. The more
// specific keys come first: an email's `text` is its display label, not the address.
export function normalizeMondayColumnValue(value: unknown): string | number | undefined {
  if (typeof value !== 'object' || value === null) return scalar(value);
  if (Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  for (const key of ['email', 'phone', 'date', 'value']) {
    const s = scalar(v[key]);
    if (s !== undefined) return s;
  }
  const label = v.label;
  if (typeof label === 'object' && label !== null) {
    const s = scalar((label as Record<string, unknown>).text);
    if (s !== undefined) return s;
  }
  return scalar(v.text);
}

export function mapMondayToQbCustomerFields(
  mondayColumnValues: Record<string, unknown>,
  config: QuickbooksSyncConfig
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [mondayColumnId, qbField] of Object.entries(config.quickbooksSync.customerCreateFieldMap)) {
    const value = normalizeMondayColumnValue(mondayColumnValues[mondayColumnId]);
    if (value === undefined) continue;
    setPath(result, qbField, value);
  }
  return result;
}
