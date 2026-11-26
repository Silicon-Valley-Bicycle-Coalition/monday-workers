// Validates a config/*.json at startup so a placeholder or a typo fails the first search, not a
// silent hourly cron. The shipped JSON files hold REPLACE_WITH_* / null placeholders until the
// boards are wired, so they deliberately do NOT validate; tests validate fixtures instead.
import production from '../config/svbc.json';
import sandbox from '../config/sandbox.json';
import { createConfigSelector } from './environment';
import type { ContactKind } from './types';

export const CONTACT_KINDS: readonly ContactKind[] = ['person', 'historical', 'organization'];

export interface SourceBoard {
  kind: ContactKind;
  boardId: number;
  latColumn: string;
  lngColumn: string;
  nameColumn: string | null; // null = the item's own name
  nearbyColumn: string | null; // null only for organizations
  address: { street: string; city: string; state: string; zip: string } | null; // null = the geocode cron skips this board
}

export interface Config {
  monday: {
    apiUrl: string;
    sources: SourceBoard[];
    resultsWorkspaceIds: number[];
    eventsBoardId: number;
    eventsAddressColumn: string;
  };
  osm: { nominatimUrl: string; overpassUrl: string; userAgent: string };
  // [south, west, north, east] — Overpass bbox order.
  serviceArea: [number, number, number, number];
  // teamDomain is the bare host (no scheme); allowedEmailDomain is lowercase, without the @.
  access: { teamDomain: string; aud: string; allowedEmailDomain: string };
  geocode: { censusUrl: string; perRun: number };
}

const PLACEHOLDER = /^REPLACE_/;
// An Access team domain is always <team>.cloudflareaccess.com; anything else would make the Worker
// fetch signing keys from (and trust tokens issued by) a host Cloudflare doesn't run.
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;
const EMAIL_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
type Obj = Record<string, unknown>;

function obj(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`config ${path} must be an object`);
  return value as Obj;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`config ${path} must be a non-empty string`);
  if (PLACEHOLDER.test(value)) throw new Error(`config ${path} is still a placeholder (${value})`);
  return value;
}

function id(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`config ${path} must be a positive integer id`);
  return value;
}

function source(raw: unknown, index: number): SourceBoard {
  const path = `monday.sources[${index}]`;
  const s = obj(raw, path);
  const kind = s.kind;
  if (!CONTACT_KINDS.includes(kind as ContactKind)) throw new Error(`config ${path}.kind must be one of ${CONTACT_KINDS.join(', ')}`);
  let nearbyColumn: string | null = null;
  if (s.nearbyColumn === null || s.nearbyColumn === undefined) {
    if (kind !== 'organization') throw new Error(`config ${path}.nearbyColumn may be null only for organization`);
  } else {
    nearbyColumn = str(s.nearbyColumn, `${path}.nearbyColumn`);
  }
  let address: SourceBoard['address'] = null;
  if (s.address !== null && s.address !== undefined) {
    const a = obj(s.address, `${path}.address`);
    address = {
      street: str(a.street, `${path}.address.street`),
      city: str(a.city, `${path}.address.city`),
      state: str(a.state, `${path}.address.state`),
      zip: str(a.zip, `${path}.address.zip`),
    };
  }
  return {
    kind: kind as ContactKind,
    boardId: id(s.boardId, `${path}.boardId`),
    latColumn: str(s.latColumn, `${path}.latColumn`),
    lngColumn: str(s.lngColumn, `${path}.lngColumn`),
    nameColumn: s.nameColumn === null || s.nameColumn === undefined ? null : str(s.nameColumn, `${path}.nameColumn`),
    nearbyColumn,
    address,
  };
}

export function validateConfig(raw: unknown): Config {
  const root = obj(raw, 'root');
  const m = obj(root.monday, 'monday');
  if (!Array.isArray(m.sources)) throw new Error('config monday.sources must be an array');
  const sources = m.sources.map(source);
  for (const kind of CONTACT_KINDS) {
    const count = sources.filter((s) => s.kind === kind).length;
    if (count === 0) throw new Error(`config monday.sources has no ${kind} board`);
    // The consumer looks a contact's source board up by kind, so each kind maps to one board.
    if (count > 1) throw new Error(`config monday.sources has more than one ${kind} board`);
  }
  if (!Array.isArray(m.resultsWorkspaceIds) || m.resultsWorkspaceIds.length === 0) {
    throw new Error('config monday.resultsWorkspaceIds must be a non-empty array');
  }
  const resultsWorkspaceIds = m.resultsWorkspaceIds.map((w, i) => id(w, `monday.resultsWorkspaceIds[${i}]`));

  const osm = obj(root.osm, 'osm');
  const area = root.serviceArea;
  if (!Array.isArray(area) || area.length !== 4 || area.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error('config serviceArea must be [south, west, north, east]');
  }
  const [south, west, north, east] = area as [number, number, number, number];
  if (south < -90 || north > 90 || west < -180 || east > 180) throw new Error('config serviceArea is outside valid latitude/longitude');
  if (south >= north) throw new Error('config serviceArea south must be less than north');
  if (west >= east) throw new Error('config serviceArea west must be less than east');

  const access = obj(root.access, 'access');
  const teamDomain = str(access.teamDomain, 'access.teamDomain');
  if (!TEAM_DOMAIN.test(teamDomain)) throw new Error('config access.teamDomain must be a bare <team>.cloudflareaccess.com host');
  const allowedEmailDomain = str(access.allowedEmailDomain, 'access.allowedEmailDomain');
  if (!EMAIL_DOMAIN.test(allowedEmailDomain)) throw new Error('config access.allowedEmailDomain must be a lowercase domain, without @');
  const geocode = obj(root.geocode, 'geocode');
  const perRun = geocode.perRun;
  if (typeof perRun !== 'number' || !Number.isInteger(perRun) || perRun <= 0) throw new Error('config geocode.perRun must be a positive integer');

  return {
    monday: {
      apiUrl: str(m.apiUrl, 'monday.apiUrl'),
      sources,
      resultsWorkspaceIds,
      eventsBoardId: id(m.eventsBoardId, 'monday.eventsBoardId'),
      eventsAddressColumn: str(m.eventsAddressColumn, 'monday.eventsAddressColumn'),
    },
    osm: {
      nominatimUrl: str(osm.nominatimUrl, 'osm.nominatimUrl'),
      overpassUrl: str(osm.overpassUrl, 'osm.overpassUrl'),
      userAgent: str(osm.userAgent, 'osm.userAgent'),
    },
    serviceArea: [south, west, north, east],
    access: { teamDomain, aud: str(access.aud, 'access.aud'), allowedEmailDomain },
    geocode: { censusUrl: str(geocode.censusUrl, 'geocode.censusUrl'), perRun },
  };
}

// Selected per request by env.ENVIRONMENT (src/environment.ts); validated once per isolate.
export const configFor = createConfigSelector({ production, sandbox, validate: validateConfig });
