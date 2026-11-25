import type { EventbriteSyncConfig } from '../types';

/**
 * The county a home ZIP is counted in, or null for one on no list. Overrides win, then Pledge to
 * Ride's San Mateo and Santa Clara lists (left as they are: that board's results rest on them), then
 * this feature's own lists for the other counties.
 */
export function homeCounty(zip: string, config: EventbriteSyncConfig): string | null {
  const { lists, overrides } = config.attendeeSync.zipCounty;
  if (Object.hasOwn(overrides, zip)) return overrides[zip]!;
  for (const [county, zips] of [...Object.entries(config.pledge?.zipCounty ?? {}), ...Object.entries(lists)]) {
    if (zips.includes(zip)) return county;
  }
  return null;
}
