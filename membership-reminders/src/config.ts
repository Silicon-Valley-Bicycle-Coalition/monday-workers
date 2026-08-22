import type { Config, MondayColumns } from './types';

const REQUIRED_TOP_LEVEL = [
  'monday',
  'stages',
  'renewalUrl',
  'timeZone',
  'lifetimeTierValue',
  'activeStatusValue',
] as const;

const REQUIRED_COLUMNS: (keyof MondayColumns)[] = [
  'membershipStatus',
  'membershipTier',
  'memberUntil',
  'remindersSent',
  'email',
];

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in cfg)) {
      throw new Error(`config: missing required key "${key}"`);
    }
  }

  if (typeof cfg.monday !== 'object' || cfg.monday === null) {
    throw new Error('config: missing required key "monday"');
  }

  const monday = cfg.monday as Record<string, unknown>;
  const columns = monday.columns as Record<string, unknown> | undefined;
  if (!columns) {
    throw new Error('config: missing required key "monday.columns"');
  }
  for (const key of REQUIRED_COLUMNS) {
    if (!(key in columns)) {
      throw new Error(`config: missing required key "monday.columns.${key}"`);
    }
  }

  if (!Array.isArray(cfg.stages) || cfg.stages.length === 0) {
    throw new Error('config: "stages" must be a non-empty array');
  }

  return cfg as unknown as Config;
}
