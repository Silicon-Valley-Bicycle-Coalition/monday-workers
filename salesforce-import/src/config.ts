import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EraRule { key: string; label: string; startYear: number | null; endYear: number | null; boardId?: number }
export interface Config {
  salesforceOrg: string;
  cutoverDateISO: string;
  peopleActiveSinceISO: string;
  activitySliceSinceISO: string;
  eraMaxItems: number;
  monday: { apiUrl: string; boardSuffix: string; workspaceId?: number | null; boards: Record<string, number | null> };
  localNews: { rules: { cities: string[]; url: string; name: string }[]; defaultUrl: string; defaultName: string };
  reconciliation: Record<string, number>;
}

const REQUIRED = ['salesforceOrg', 'cutoverDateISO', 'peopleActiveSinceISO',
  'activitySliceSinceISO', 'eraMaxItems', 'monday', 'localNews', 'reconciliation'] as const;

function defaultConfigPath(): string {
  const cwdPath = resolve(process.cwd(), 'config', 'svbc.json'); // lets tests/forks override per-directory
  return existsSync(cwdPath) ? cwdPath : new URL('../config/svbc.json', import.meta.url).pathname;
}

export function loadConfig(path = defaultConfigPath()): Config {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`config: cannot read ${path}`); }
  const cfg = JSON.parse(raw) as Config;
  for (const key of REQUIRED) {
    if (!(key in cfg)) throw new Error(`config: missing required key "${key}" in ${path}`);
  }
  return cfg;
}
