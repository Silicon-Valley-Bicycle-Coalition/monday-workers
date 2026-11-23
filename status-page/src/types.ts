// What every status row on the page reduces to. 'unknown' means "Couldn't check" and must never
// render as healthy; 'link-only' is a vendor with no machine-readable feed.
export type Level = 'operational' | 'degraded' | 'maintenance' | 'outage' | 'unknown' | 'link-only';

export interface Incident {
  name: string;
  url: string;
}
