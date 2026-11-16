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
  // Salesforce ids of One-to-One Accounts that are really organizations: someone typed the org in
  // as a Contact ("SVBC Volunteer", "San Mateo City Council") and NPSP auto-made the Account.
  // They migrate as Organizations items so affiliations to them (and their roles) survive, and a
  // Contact that merely restates the Account's name is not emitted as a Person. Curated by hand;
  // no name heuristic tells these from a real person's own Account.
  organizationAccountSfIds?: string[];
  // Salesforce user the Eventbrite package (eb4sf) writes paid ticket orders as (SVBC: "SVBC
  // Integration"). A Closed Won Opportunity created by this user is an event ticket order and
  // migrates as Status Received / Gift Type "Event Ticket" (#43); Closed Won gifts anyone else
  // created stay Received (Historical). Omit to treat every Closed Won gift as historical.
  eventbriteIntegrationUserName?: string;
  // Load throughput (#22): batchSize create_items per request, concurrency requests in flight,
  // inlineLinks (relations to already-loaded targets written inside create_item), and the pause
  // before a recovery lookup. Optional — src/load/options.ts has the defaults; CLI flags override.
  load?: LoadConfig;
  // Browser bases for the validate sample sheet's per-row links (#13): the Monday account
  // (https://<account>.monday.com) and the Salesforce My Domain (https://<domain>.my.salesforce.com).
  // Optional — the link columns stay blank without them.
  salesforceInstanceUrl?: string;
  monday: { apiUrl: string; accountUrl?: string; boardSuffix: string; workspaceId?: number | null; boards: Record<string, number | null> };
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
  const ebUser = cfg.eventbriteIntegrationUserName;
  if (ebUser !== undefined && (typeof ebUser !== 'string' || ebUser.trim() === '')) {
    throw new Error(`config: "eventbriteIntegrationUserName" must be a non-empty string in ${path}`);
  }
  // A present-but-null workspaceId is the cutover placeholder (runbook 0.5): the production config
  // is prepared before the production workspace exists (runbook 0.3). Fail here rather than let
  // create_board fall through to the account's Main workspace. Omit the key entirely to opt into
  // that fallback on purpose (a fork whose Main workspace allows it).
  if ('workspaceId' in cfg.monday) {
    const ws = cfg.monday.workspaceId;
    if (typeof ws !== 'number' || !Number.isInteger(ws) || ws <= 0) {
      throw new Error(`config: "monday.workspaceId" is ${JSON.stringify(ws)} in ${path} — set it to the production workspace id (cutover runbook step 0.3) or remove the key`);
    }
  }
  return cfg;
}
