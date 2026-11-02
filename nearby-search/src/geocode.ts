// Hourly backfill: contacts with an address but no Lat/Lng get coordinates from the US Census
// geocoder. Logs carry counts only — never an address, name or email.
import type { Config, SourceBoard } from './config';
import { runDisposition, type WriteMode } from './flags';
import type { NearbyMondayClient } from './monday/client';

const WORKER = 'nearby-search';
const CENSUS_TIMEOUT_MS = 10_000;
// A Census outage looks the same for every item; stop rather than burn the budget on it.
const MAX_CONSECUTIVE_ERRORS = 3;

interface CensusResponse { result?: { addressMatches?: { coordinates?: { x?: number; y?: number } }[] } }

// null = Census answered and found no match (a miss). An HTTP error, timeout or unreadable body
// throws, because that says nothing about the address.
export async function geocodeOne(
  address: string,
  censusUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{ lat: number; lng: number } | null> {
  const url = new URL(censusUrl);
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  const res = await fetcher(url.toString(), { signal: AbortSignal.timeout(CENSUS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`census geocoder HTTP ${res.status}`);
  const body = (await res.json()) as CensusResponse;
  const c = body.result?.addressMatches?.[0]?.coordinates;
  if (c === undefined || typeof c.x !== 'number' || typeof c.y !== 'number') return null;
  return { lat: c.y, lng: c.x };
}

// SHA-256 hex of the trimmed, lowercased, whitespace-collapsed address.
export async function addressHash(address: string): Promise<string> {
  const normalized = address.trim().toLowerCase().replace(/\s+/g, ' ');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface GeocodeResult { geocoded: number; missed: number; skipped: number }

export async function runGeocode(deps: { monday: NearbyMondayClient; db: D1Database; config: Config; mode: WriteMode }): Promise<GeocodeResult> {
  const result: GeocodeResult = { geocoded: 0, missed: 0, skipped: 0 };
  const disposition = runDisposition(deps.mode);
  if (disposition === 'skip') {
    console.warn(`${WORKER} geocode: write mode is "${deps.mode}"; skipping this hour's backfill`);
    return result;
  }

  const { perRun, censusUrl } = deps.config.geocode;
  const misses = new Map<string, string>();
  const rows = await deps.db.prepare('SELECT item_id, address_hash FROM geocode_misses').all<{ item_id: string; address_hash: string }>();
  for (const r of rows.results) misses.set(r.item_id, r.address_hash);

  let budget = perRun;
  let consecutiveErrors = 0;
  let stopped = false;
  const sources: SourceBoard[] = deps.config.monday.sources.filter((s) => s.address !== null);
  for (const src of sources) {
    if (budget <= 0 || stopped) break;
    // Recorded misses stay in Monday's "no coordinates" list, so over-fetch by their number or
    // enough of them would starve every fresh item behind them.
    const candidates = await deps.monday.listMissingCoordinates(src, budget + misses.size);
    for (const item of candidates) {
      if (budget <= 0 || stopped) break;
      const hash = await addressHash(item.address);
      if (misses.get(item.id) === hash) { result.skipped++; continue; }
      budget--;
      let found: { lat: number; lng: number } | null;
      try {
        found = await geocodeOne(item.address, censusUrl);
        consecutiveErrors = 0;
      } catch {
        result.skipped++;
        if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) stopped = true;
        continue;
      }
      if (found === null) {
        // Internal state, not a sink: recorded under dry-run too so an `off` run does not retry
        // the same unmatched addresses forever.
        await deps.db
          .prepare('INSERT INTO geocode_misses (item_id, address_hash, attempted_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET address_hash = excluded.address_hash, attempted_at = excluded.attempted_at')
          .bind(item.id, hash, new Date().toISOString())
          .run();
        misses.set(item.id, hash);
        result.missed++;
        continue;
      }
      if (disposition === 'run') await deps.monday.setCoordinates(src, item.id, found.lat, found.lng);
      result.geocoded++;
    }
  }
  console.log(JSON.stringify({ worker: WORKER, geocode: true, ...(disposition === 'dry-run' ? { writeSwitch: 'dry-run' } : {}), ...result, stoppedEarly: stopped }));
  return result;
}
