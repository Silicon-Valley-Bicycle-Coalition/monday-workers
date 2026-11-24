// Atlassian Statuspage's /api/v2/summary.json, the format most vendors (and Cloudflare) publish.

import type { Level } from '../types';

export interface StatuspageSummary {
  indicator: string;
  components: { name: string; status: string }[];
  incidents: { name: string; shortlink: string; componentNames: string[] }[];
  maintenances: { name: string; shortlink: string; status: string; componentNames: string[] }[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const names = (v: unknown) => (Array.isArray(v) ? v.filter(isObj).map((c) => text(c.name)).filter(Boolean) : []);

/** null when the body isn't a Statuspage summary. */
export function parseStatuspage(json: unknown): StatuspageSummary | null {
  if (!isObj(json) || !isObj(json.status) || typeof json.status.indicator !== 'string') return null;
  const components = json.components ?? [];
  const incidents = json.incidents ?? [];
  const maintenances = json.scheduled_maintenances ?? [];
  if (!Array.isArray(components) || !Array.isArray(incidents) || !Array.isArray(maintenances)) return null;
  return {
    indicator: json.status.indicator,
    components: components.filter(isObj).map((c) => ({ name: text(c.name), status: text(c.status) })),
    incidents: incidents.filter(isObj).map((i) => ({ name: text(i.name), shortlink: text(i.shortlink), componentNames: names(i.components) })),
    maintenances: maintenances
      .filter(isObj)
      .map((m) => ({ name: text(m.name), shortlink: text(m.shortlink), status: text(m.status), componentNames: names(m.components) })),
  };
}

export function indicatorLevel(indicator: string): Level {
  switch (indicator) {
    case 'none': return 'operational';
    case 'minor': return 'degraded';
    case 'major':
    case 'critical': return 'outage';
    case 'maintenance': return 'maintenance';
    default: return 'unknown';
  }
}

export function componentLevel(status: string): Level {
  switch (status) {
    case 'operational': return 'operational';
    case 'degraded_performance': return 'degraded';
    case 'partial_outage':
    case 'major_outage': return 'outage';
    case 'under_maintenance': return 'maintenance';
    default: return 'unknown';
  }
}
