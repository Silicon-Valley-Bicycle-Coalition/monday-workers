import type { EnrichmentRow } from './index.js';

export interface AddressParts {
  street: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * Splits a Places `formattedAddress` ("street[, street2], city, ST zip, USA")
 * into the parts the geocode stage and transform expect. Returns null for
 * anything that isn't a US street address (city-only results, empty strings) —
 * those aren't usable as a mailing address.
 */
export function parseFormattedAddress(formatted: string): AddressParts | null {
  const parts = formatted.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 4) return null;
  const last = parts[parts.length - 1]!;
  if (!/^(usa|united states)$/i.test(last)) return null;
  const stateZip = parts[parts.length - 2]!.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!stateZip) return null;
  const city = parts[parts.length - 3]!;
  const street = parts.slice(0, parts.length - 3).join(', ');
  if (!street) return null;
  return { street, city, state: stateZip[1]!, zip: stateZip[2]! };
}

export interface MergeableEnrichment {
  website: string;
  address: string;
  parts: AddressParts | null;
}

/**
 * The subset of enrichment rows that may actually be merged into payloads:
 * 'exact' name matches always, others only when a human added the sfId to
 * data/enrich/approved.txt. Weak/no-result rows never merge implicitly.
 */
export function mergeableEnrichment(
  rows: EnrichmentRow[],
  approved: Set<string>
): Map<string, MergeableEnrichment> {
  const map = new Map<string, MergeableEnrichment>();
  for (const row of rows) {
    if (row.confidence === 'none') continue;
    if (row.confidence !== 'exact' && !approved.has(row.sfId)) continue;
    map.set(row.sfId, {
      website: row.website,
      address: row.address,
      parts: parseFormattedAddress(row.address),
    });
  }
  return map;
}
