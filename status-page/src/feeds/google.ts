// Google Workspace Status Dashboard incidents.json: every recent incident; an open one has no
// `end`. Only incidents touching a product SVBC uses count.

import type { Incident, Level } from '../types';
import { worst } from './levels';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const DASHBOARD = 'https://www.google.com/appsstatus/dashboard/';
const IMPACT_LEVEL: Record<string, Level> = { SERVICE_OUTAGE: 'outage', SERVICE_DISRUPTION: 'degraded' }; // INFORMATION: listed only

function title(i: Json): string {
  const lines = String(i.external_desc ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] === '**Summary:**' ? lines[1] : lines[0]?.replace(/^\*\*Summary:\*\*\s*/, '');
  return first || String(i.service_name ?? 'Google Workspace incident');
}

export function parseGoogle(json: unknown, products: string[]): { level: Level; incidents: Incident[] } | null {
  if (!Array.isArray(json)) return null;
  const all = json.filter(isObj);
  if (all.length !== json.length || all.some((i) => typeof i.uri !== 'string' || !Array.isArray(i.affected_products))) return null;
  const wanted = new Set(products);
  const open = all.filter(
    (i) => !i.end && (i.affected_products as unknown[]).some((p) => isObj(p) && wanted.has(String(p.title))),
  );
  return {
    level: worst(open.map((i) => IMPACT_LEVEL[String(i.status_impact)] ?? 'operational')),
    incidents: open.map((i) => ({ name: title(i), url: DASHBOARD + String(i.uri) })),
  };
}
