import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LoadConfig } from './load/options.js';

export interface Config {
  salesforceOrg: string;
  cutoverDateISO: string;
  peopleActiveSinceISO: string;
  activitySliceSinceISO: string;
  boardMaxItems: number;
  // How many fiscal years of donations stay active (unarchived) on the Donations board;
  // everything older is archived in place during load. 2 = current + previous FY.
  donationsActiveFiscalYears: number;
  // Domains that mean "a person's own mailbox", never an organization's. A Secondary_Email__c on
  // one of these becomes Household Email; anything else that isn't an affiliated org's domain
  // goes to the human review file (see transform/emails.ts).
  consumerEmailDomains?: string[];
  // Salesforce ids of placeholder donor records (SVBC: the "Anonymous Person" Contact and its
  // household Account). Gifts pointing at them migrate as Anonymous Donor = checked with no
  // Donor link, and the records themselves are not emitted as People/Organizations items.
  placeholderDonorSfIds?: string[];
  // Load throughput (#22): batchSize create_items per request, concurrency requests in flight,
  // inlineLinks (relations to already-loaded targets written inside create_item), and the pause
  // before a recovery lookup. Optional — src/load/options.ts has the defaults; CLI flags override.
  load?: LoadConfig;
  monday: { apiUrl: string; boardSuffix: string; workspaceId?: number | null; boards: Record<string, number | null> };
  localNews: { rules: { cities: string[]; url: string; name: string }[]; defaultUrl: string; defaultName: string };
  reconciliation: Record<string, number>;
}

const REQUIRED = ['salesforceOrg', 'cutoverDateISO', 'peopleActiveSinceISO',
  'activitySliceSinceISO', 'boardMaxItems', 'donationsActiveFiscalYears',
  'monday', 'localNews', 'reconciliation'] as const;

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
