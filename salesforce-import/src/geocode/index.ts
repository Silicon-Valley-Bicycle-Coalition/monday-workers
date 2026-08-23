import { registerCommand } from '../commands.js';
import { dataPath, readNdjson } from '../artifacts.js';
import { normalizeAddress } from './normalize.js';
import { GeoCache } from './cache.js';
import { censusBatch } from './census.js';
import { googleGeocode } from './google.js';
import { existsSync } from 'node:fs';
import { parseFormattedAddress } from '../enrich/address.js';
import type { EnrichmentRow } from '../enrich/index.js';

interface Addr { key: string; street: string; city: string; state: string; zip: string }

// Places-enriched org addresses (optional artifact) get geocoded like any Salesforce address.
async function collectEnriched(): Promise<Addr[]> {
  const path = dataPath('enrich', 'organizations.ndjson');
  if (!existsSync(path)) return [];
  const out: Addr[] = [];
  for (const row of await readNdjson<EnrichmentRow>(path)) {
    if (row.confidence === 'none' || row.confidence === 'weak') continue;
    const parts = parseFormattedAddress(row.address);
    if (!parts) continue;
    const key = normalizeAddress(parts);
    if (key) out.push({ key, ...parts });
  }
  return out;
}

function collect(rows: Record<string, unknown>[], prefix: 'Mailing' | 'Billing'): Addr[] {
  const out: Addr[] = [];
  for (const r of rows) {
    const parts = {
      street: r[`${prefix}Street`] as string | null, city: r[`${prefix}City`] as string | null,
      state: r[`${prefix}State`] as string | null, zip: r[`${prefix}PostalCode`] as string | null,
    };
    const key = normalizeAddress(parts);
    if (key) out.push({ key, street: parts.street!, city: parts.city!,
      state: parts.state ?? '', zip: parts.zip ?? '' });
  }
  return out;
}

export async function runGeocode(_args: string[], deps: { fetchFn?: typeof fetch } = {}): Promise<number> {
  const contacts = await readNdjson<Record<string, unknown>>(dataPath('extract', 'contacts.ndjson'));
  const accounts = await readNdjson<Record<string, unknown>>(dataPath('extract', 'accounts.ndjson'));
  const all = [...collect(contacts, 'Mailing'), ...collect(accounts, 'Billing'), ...(await collectEnriched())];
  const unique = [...new Map(all.map((a) => [a.key, a])).values()];

  const cache = new GeoCache();
  await cache.load();
  const pending = unique.filter((a) => !cache.get(a.key));
  let census = 0, google = 0;

  if (pending.length > 0) {
    const matched = await censusBatch(pending, deps);
    for (const [key, r] of matched) { await cache.set(key, r); census++; }

    const apiKey = process.env['GOOGLE_MAPS_API_KEY'];
    const unmatched = pending.filter((a) => !matched.has(a.key));
    if (apiKey) {
      for (const a of unmatched) {
        const r = await googleGeocode(`${a.street}, ${a.city}, ${a.state} ${a.zip}`, apiKey, deps);
        if (r) { await cache.set(a.key, r); google++; }
      }
    } else if (unmatched.length > 0) {
      console.warn(`geocode: ${unmatched.length} unmatched and GOOGLE_MAPS_API_KEY unset — leaving unresolved`);
    }
  }
  const unresolved = unique.filter((a) => !cache.get(a.key)).length;
  console.log(`geocode: total=${unique.length} cached=${unique.length - pending.length} census=${census} google=${google} unresolved=${unresolved}`);
  return 0;
}

registerCommand('geocode', (args) => runGeocode(args));
