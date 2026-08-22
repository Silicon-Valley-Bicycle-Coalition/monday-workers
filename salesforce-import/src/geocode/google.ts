import type { GeoResult } from './cache.js';

export async function googleGeocode(
  oneLine: string, apiKey: string, deps: { fetchFn?: typeof fetch } = {},
): Promise<GeoResult | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(oneLine)}&key=${apiKey}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`google geocode: HTTP ${res.status}`);
  const body = await res.json() as {
    status: string;
    results: { geometry: { location: { lat: number; lng: number } };
      address_components: { long_name: string; types: string[] }[] }[];
  };
  const top = body.results[0];
  if (body.status !== 'OK' || !top) return null;
  const comp = (type: string) => top.address_components.find((c) => c.types.includes(type))?.long_name ?? '';
  return { lat: top.geometry.location.lat, lng: top.geometry.location.lng,
    city: comp('locality'), zip: comp('postal_code'), source: 'google' };
}
