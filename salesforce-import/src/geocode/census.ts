import type { GeoResult } from './cache.js';

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const CHUNK = 10_000;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Split one CSV line honoring quotes (census quotes every field).
function splitCsv(line: string): string[] {
  const m = line.match(/"((?:[^"]|"")*)"/g) ?? [];
  return m.map((f) => f.slice(1, -1).replace(/""/g, '"'));
}

export async function censusBatch(
  addresses: { key: string; street: string; city: string; state: string; zip: string }[],
  deps: { fetchFn?: typeof fetch } = {},
): Promise<Map<string, GeoResult>> {
  const fetchFn = deps.fetchFn ?? fetch;
  const out = new Map<string, GeoResult>();

  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const keyByRowId = new Map(chunk.map((a, idx) => [String(idx + 1), a.key]));
    const csv = chunk.map((a, idx) =>
      `"${idx + 1}","${a.street.replace(/"/g, '')}","${a.city.replace(/"/g, '')}","${a.state}","${a.zip}"`,
    ).join('\n');

    const form = new FormData();
    form.set('benchmark', 'Public_AR_Current');
    form.set('addressFile', new Blob([csv], { type: 'text/csv' }), 'batch.csv');
    const res = await fetchFn(ENDPOINT, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`census: HTTP ${res.status}`);

    for (const line of (await res.text()).split(/\r?\n/).filter(Boolean)) {
      const cells = splitCsv(line);
      if (cells[2] !== 'Match') continue;
      const key = keyByRowId.get(cells[0] ?? '');
      const matched = (cells[4] ?? '').split(',').map((s) => s.trim()); // street, city, state, zip
      const [lng, lat] = (cells[5] ?? '').split(',').map(Number);
      if (!key || lat === undefined || Number.isNaN(lat)) continue;
      out.set(key, {
        lat, lng: lng!, city: titleCase(matched[1] ?? ''), zip: matched[3] ?? '', source: 'census',
      });
    }
  }
  return out;
}
