// slack-status.com/api/v2.0.0/current: { status: 'ok' | 'active', active_incidents: [...] }.

import type { Incident, Level } from '../types';
import { worst } from './levels';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const TYPE_LEVEL: Record<string, Level> = { outage: 'outage', incident: 'degraded' }; // notice: listed only

export function parseSlack(json: unknown): { level: Level; incidents: Incident[] } | null {
  if (!isObj(json) || typeof json.status !== 'string' || !Array.isArray(json.active_incidents)) return null;
  if (json.status === 'ok') return { level: 'operational', incidents: [] };
  const active = json.active_incidents.filter(isObj);
  return {
    level: worst(active.map((i) => TYPE_LEVEL[String(i.type)] ?? 'operational')),
    incidents: active.map((i) => ({ name: String(i.title ?? 'Slack incident'), url: String(i.url ?? '') })),
  };
}
