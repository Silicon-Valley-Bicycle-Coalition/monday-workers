import type { GeoResult } from './cache.js';
import { withRetry, type RetryDeps } from './retry.js';

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
// The API accepts up to 10k rows, but server-side processing time scales with batch size and
// big batches blow past undici's headers timeout (~5 min) — observed live 2026-08-25 with a
// cold cache. 2k keeps each request comfortably fast and bounds what one failed chunk loses.
const CHUNK = 2_000;

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
  deps: { fetchFn?: typeof fetch } & RetryDeps = {},
): Promise<Map<string, GeoResult>> {
  const fetchFn = deps.fetchFn ?? fetch;
  const out = new Map<string, GeoResult>();
  const chunkCount = Math.ceil(addresses.length / CHUNK);

  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const chunkNo = i / CHUNK + 1;
    const keyByRowId = new Map(chunk.map((a, idx) => [String(idx + 1), a.key]));
    const csv = chunk.map((a, idx) =>
      `"${idx + 1}","${a.street.replace(/"/g, '')}","${a.city.replace(/"/g, '')}","${a.state}","${a.zip}"`,
    ).join('\n');

    let text: string;
    try {
      text = await withRetry(async () => {
        // FormData is rebuilt per attempt — a consumed request body can't be re-sent.
        const form = new FormData();
        form.set('benchmark', 'Public_AR_Current');
        form.set('addressFile', new Blob([csv], { type: 'text/csv' }), 'batch.csv');
        const res = await fetchFn(ENDPOINT, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`census: HTTP ${res.status}`);
        return res.text();
      }, `census chunk ${chunkNo}/${chunkCount}`, deps);
    } catch (err) {
      // One dead chunk isn't the run's problem: its addresses fall through unmatched to the
      // Google fallback (or stay unresolved), same as any Census non-match.
      console.warn(`census: chunk ${chunkNo}/${chunkCount} failed after retries (${String(err)}) — ` +
        `${chunk.length} addresses fall through to the fallback`);
      continue;
    }

    for (const line of text.split(/\r?\n/).filter(Boolean)) {
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
    console.log(`geocode progress: census chunk ${chunkNo}/${chunkCount} done, matched so far ${out.size}`);
  }
  return out;
}
