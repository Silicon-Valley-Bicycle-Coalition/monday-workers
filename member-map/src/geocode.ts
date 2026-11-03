// Private geocoding for People added after the migration: Address filled, Lat/Lng blank. Results
// are cached in D1 only (keyed by item id + address hash) and never written back to Monday. Only
// addresses of rows without usable board coordinates leave the Worker, to the free U.S. Census
// batch geocoder. Logs carry counts only, never addresses, names or ids.

import type { BoardRecord } from './monday/client';
import type { MapConfig } from './config';

export interface LatLng { lat: number; lng: number }
export interface GeocodeRow {
  itemId: string; addressHash: string; status: 'match' | 'nomatch';
  lat: number | null; lng: number | null; geocodedAt: string;
}
export interface GeocodeStore {
  getMany(itemIds: string[]): Promise<Map<string, GeocodeRow>>;
  putMany(rows: GeocodeRow[]): Promise<void>;
}
export interface BatchInput { id: string; street: string; city: string; state: string; zip: string }
export interface Geocoder { geocode(rows: BatchInput[]): Promise<Map<string, LatLng | null>> }

// D1 allows 100 bound parameters per statement.
const D1_IN_CHUNK = 100;

interface D1Row {
  item_id: string; address_hash: string; status: 'match' | 'nomatch';
  lat: number | null; lng: number | null; geocoded_at: string;
}

export class D1GeocodeStore implements GeocodeStore {
  constructor(private readonly db: D1Database) {}

  async getMany(itemIds: string[]): Promise<Map<string, GeocodeRow>> {
    const out = new Map<string, GeocodeRow>();
    for (let i = 0; i < itemIds.length; i += D1_IN_CHUNK) {
      const chunk = itemIds.slice(i, i + D1_IN_CHUNK);
      const marks = chunk.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(`SELECT item_id, address_hash, status, lat, lng, geocoded_at FROM geocodes WHERE item_id IN (${marks})`)
        .bind(...chunk)
        .all<D1Row>();
      for (const r of results ?? []) {
        out.set(r.item_id, {
          itemId: r.item_id, addressHash: r.address_hash, status: r.status,
          lat: r.lat, lng: r.lng, geocodedAt: r.geocoded_at,
        });
      }
    }
    return out;
  }

  async putMany(rows: GeocodeRow[]): Promise<void> {
    if (rows.length === 0) return;
    const sql = `INSERT INTO geocodes (item_id, address_hash, status, lat, lng, geocoded_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET address_hash = excluded.address_hash, status = excluded.status,
        lat = excluded.lat, lng = excluded.lng, geocoded_at = excluded.geocoded_at`;
    await this.db.batch(
      rows.map((r) => this.db.prepare(sql).bind(r.itemId, r.addressHash, r.status, r.lat, r.lng, r.geocodedAt)),
    );
  }
}

export function boardCoordinates(lat: string | null, lng: string | null): LatLng | null {
  if (lat === null || lng === null || lat.trim() === '' || lng.trim() === '') return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  if (la === 0 && ln === 0) return null;
  return { lat: la, lng: ln };
}

function clean(v: string | null): string {
  return (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeAddress(r: Pick<BoardRecord, 'address' | 'city' | 'zip'>): string | null {
  const address = clean(r.address);
  if (address === '') return null;
  return [address, clean(r.city), clean(r.zip).slice(0, 5)].join('|');
}

export async function addressHash(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// RFC 4180: quote only when the field holds a comma, quote or line break.
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildBatchCsv(rows: BatchInput[]): string {
  return rows.map((r) => [r.id, r.street, r.city, r.state, r.zip].map(csvField).join(',') + '\n').join('');
}

// Quote-aware CSV reader: the coordinate field itself is "lon,lat".
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') { quoted = true; any = true; }
    else if (c === ',') { row.push(field); field = ''; any = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || field !== '') { row.push(field); records.push(row); }
      row = []; field = ''; any = false;
    } else { field += c; any = true; }
  }
  if (any || field !== '') { row.push(field); records.push(row); }
  return records;
}

// Columns: id, input, Match|No_Match|Tie, Exact|Non_Exact, matched address, "lon,lat", tigerId, side.
// Census orders coordinates lon,lat; a Tie is treated as no match rather than guessing.
export function parseBatchResponse(csv: string): Map<string, LatLng | null> {
  const out = new Map<string, LatLng | null>();
  for (const f of parseCsv(csv)) {
    const id = f[0];
    if (!id) continue;
    let point: LatLng | null = null;
    if (f[2] === 'Match') {
      const [lon, lat] = (f[5] ?? '').split(',').map((s) => Number(s.trim()));
      if (Number.isFinite(lon) && Number.isFinite(lat) && (f[5] ?? '').includes(',')) point = boardCoordinates(String(lat), String(lon));
    }
    out.set(id, point);
  }
  return out;
}

export class CensusGeocoder implements Geocoder {
  constructor(private readonly cfg: MapConfig['geocoder']) {}

  async geocode(rows: BatchInput[]): Promise<Map<string, LatLng | null>> {
    const form = new FormData();
    form.append('addressFile', new Blob([buildBatchCsv(rows)], { type: 'text/csv' }), 'batch.csv');
    form.append('benchmark', this.cfg.benchmark);
    const res = await fetch(this.cfg.url, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`census geocoder returned ${res.status}`);
    return parseBatchResponse(await res.text());
  }
}

const DAY_MS = 86_400_000;

export async function resolveLocations(
  records: BoardRecord[], store: GeocodeStore, geocoder: Geocoder,
  cfg: MapConfig['geocoder'], now: Date,
): Promise<{ located: Map<string, LatLng>; unplaced: number; geocoded: number }> {
  const located = new Map<string, LatLng>();
  let unplaced = 0;

  const needCache: { rec: BoardRecord; normalized: string }[] = [];
  for (const rec of records) {
    const own = boardCoordinates(rec.lat, rec.lng);
    if (own) { located.set(rec.itemId, own); continue; }
    const normalized = normalizeAddress(rec);
    if (normalized === null) { unplaced++; continue; }
    needCache.push({ rec, normalized });
  }

  const cache = await store.getMany(needCache.map((n) => n.rec.itemId));
  const queue: { rec: BoardRecord; hash: string }[] = [];
  for (const { rec, normalized } of needCache) {
    const hash = await addressHash(normalized);
    const hit = cache.get(rec.itemId);
    if (hit && hit.addressHash === hash) {
      if (hit.status === 'match' && hit.lat !== null && hit.lng !== null) {
        located.set(rec.itemId, { lat: hit.lat, lng: hit.lng });
        continue;
      }
      if (hit.status === 'nomatch' && now.getTime() - Date.parse(hit.geocodedAt) < cfg.retryNoMatchDays * DAY_MS) {
        unplaced++;
        continue;
      }
    }
    queue.push({ rec, hash });
  }

  const sending = queue.slice(0, cfg.maxPerRun);
  unplaced += queue.length - sending.length; // over the cap: no cache row, so first in line next run

  let geocoded = 0;
  let failedBatches = 0;
  for (let i = 0; i < sending.length; i += cfg.batchSize) {
    const batch = sending.slice(i, i + cfg.batchSize);
    const inputs: BatchInput[] = batch.map(({ rec }) => ({
      id: rec.itemId, street: (rec.address ?? '').trim(), city: (rec.city ?? '').trim(),
      state: cfg.defaultState, zip: (rec.zip ?? '').trim().slice(0, 5),
    }));
    try {
      const results = await geocoder.geocode(inputs);
      const rows: GeocodeRow[] = [];
      for (const { rec, hash } of batch) {
        const point = results.get(rec.itemId) ?? null;
        rows.push({
          itemId: rec.itemId, addressHash: hash, status: point ? 'match' : 'nomatch',
          lat: point?.lat ?? null, lng: point?.lng ?? null, geocodedAt: now.toISOString(),
        });
        if (point) located.set(rec.itemId, point); else unplaced++;
      }
      await store.putMany(rows);
      geocoded += batch.length;
    } catch {
      failedBatches++;
      unplaced += batch.length;
    }
  }
  if (failedBatches > 0) console.warn(`member-map: ${failedBatches} geocode batch(es) failed`);

  return { located, unplaced, geocoded };
}
