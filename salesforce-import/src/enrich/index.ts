import { registerCommand } from '../commands.js';
import { dataPath, readNdjson, appendNdjson } from '../artifacts.js';
import { existsSync } from 'node:fs';
import { searchPlace } from './places.js';
import { nameConfidence, type NameConfidence } from './match.js';

export interface EnrichmentRow {
  sfId: string;
  name: string;
  matchedName: string;
  website: string;
  address: string;
  confidence: NameConfidence | 'none';
}

const hasBillingAddress = (a: Record<string, unknown>) =>
  Boolean(a['BillingStreet'] && a['BillingCity']);

/**
 * Fills website/address gaps on organization accounts from Google Places,
 * biased to Santa Clara/San Mateo counties. Append-only artifact makes re-runs
 * skip already-queried orgs. 'exact' matches merge automatically in transform;
 * everything else is left for human review (see review notes in the README).
 */
export async function runEnrich(
  _args: string[],
  deps: { fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  const apiKey = process.env['GOOGLE_MAPS_API_KEY'];
  if (!apiKey) { console.error('enrich: GOOGLE_MAPS_API_KEY not set'); return 1; }
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const accounts = await readNdjson<Record<string, unknown>>(dataPath('extract', 'accounts.ndjson'));
  const path = dataPath('enrich', 'organizations.ndjson');
  const done = new Set<string>();
  if (existsSync(path)) {
    for (const row of await readNdjson<EnrichmentRow>(path)) done.add(row.sfId);
  }

  const pending = accounts.filter((a) =>
    a['npe01__SYSTEM_AccountType__c'] !== 'One-to-One Individual' &&
    !done.has(a['Id'] as string) &&
    (!a['Website'] || !hasBillingAddress(a)));

  let exact = 0, close = 0, weak = 0, none = 0;
  for (const a of pending) {
    const name = (a['Name'] as string) ?? '';
    const result = await searchPlace(name, { apiKey, fetchFn: deps.fetchFn });
    const row: EnrichmentRow = result
      ? { sfId: a['Id'] as string, name, matchedName: result.name,
          website: result.website, address: result.address,
          confidence: nameConfidence(name, result.name) }
      : { sfId: a['Id'] as string, name, matchedName: '', website: '', address: '', confidence: 'none' };
    await appendNdjson(path, row);
    if (row.confidence === 'exact') exact++;
    else if (row.confidence === 'close') close++;
    else if (row.confidence === 'weak') weak++;
    else none++;
    await sleepFn(60); // stay under Places' default 600 QPM
  }

  console.log(`enrich: ${pending.length} orgs queried — exact ${exact}, close ${close}, weak ${weak}, no result ${none}`);
  console.log('enrich: exact matches merge automatically; approve close/weak rows by adding their sfId to data/enrich/approved.txt');
  return 0;
}

registerCommand('enrich', (args) => runEnrich(args));
