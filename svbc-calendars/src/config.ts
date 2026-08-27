import type { CalendarsConfig, SourceConfig } from './types';

const VALID_ADAPTERS = ['legistar', 'civicplus', 'caltrainBatac', 'eventbrite'] as const;
type AdapterName = (typeof VALID_ADAPTERS)[number];

function requireString(src: Record<string, unknown>, key: string, index: number): string {
  const value = src[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`config: sources[${index}].${key} must be a non-empty string`);
  }
  return value;
}

function requireNumber(src: Record<string, unknown>, key: string, index: number): number {
  const value = src[key];
  if (typeof value !== 'number') {
    throw new Error(`config: sources[${index}].${key} must be a number`);
  }
  return value;
}

function validateSource(raw: unknown, index: number): SourceConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`config: sources[${index}] must be an object`);
  }
  const src = raw as Record<string, unknown>;

  const id = requireString(src, 'id', index);
  const name = requireString(src, 'name', index);
  const committeeName = requireString(src, 'committeeName', index);
  const adapter = requireString(src, 'adapter', index);

  if (!VALID_ADAPTERS.includes(adapter as AdapterName)) {
    throw new Error(`config: sources[${index}].adapter must be one of ${VALID_ADAPTERS.join(', ')}`);
  }

  if (adapter === 'legistar') {
    return { id, name, committeeName, adapter: 'legistar', client: requireString(src, 'client', index), bodyId: requireNumber(src, 'bodyId', index) };
  }
  if (adapter === 'civicplus') {
    return { id, name, committeeName, adapter: 'civicplus', domain: requireString(src, 'domain', index), catId: requireNumber(src, 'catId', index) };
  }
  if (adapter === 'caltrainBatac') {
    return { id, name, committeeName, adapter: 'caltrainBatac', pageUrl: requireString(src, 'pageUrl', index), titleFilter: requireString(src, 'titleFilter', index) };
  }
  return { id, name, committeeName, adapter: 'eventbrite', organizerId: requireString(src, 'organizerId', index) };
}

export function validateConfig(raw: unknown): CalendarsConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;
  if (!Array.isArray(cfg.sources)) {
    throw new Error('config: missing required key "sources" (array)');
  }
  return { sources: cfg.sources.map((s, i) => validateSource(s, i)) };
}
