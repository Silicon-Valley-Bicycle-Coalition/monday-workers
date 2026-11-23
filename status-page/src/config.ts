// Validates a config/*.json at startup so a typo fails the first request, not quietly. Every
// SVBC-specific value lives in config (the vendor list, Cloudflare components, sync labels), so a
// fork is a config change.

export type FeedSpec =
  | { kind: 'statuspage'; url: string } // base URL; /api/v2/summary.json is appended
  | { kind: 'slack'; url: string }
  | { kind: 'google'; url: string; products: string[] } // affected_products[].title values
  | { kind: 'none' };

export interface VendorSpec {
  name: string;
  usedFor: string;
  statusPageUrl: string | null; // null only for a link-only vendor with no status page at all
  feed: FeedSpec;
}

export interface SyncSpec {
  label: string;
  description: string;
  worker: string; // sync-watchdog's name for it (the Worker's directory)
  queues: string[];
}

export interface StatusConfig {
  // teamDomain "" = Cloudflare Access not set up yet; the gate then refuses every request.
  access: { teamDomain: string; aud: string; allowedEmailDomain: string };
  timezone: string;
  feedTimeoutMs: number;
  feedCacheSeconds: number;
  snapshotMaxAgeHours: number;
  syncs: SyncSpec[];
  hiddenWorkers: Record<string, string>; // watchdog-watched Workers deliberately not shown → reason
  cloudflare: { statusPageUrl: string; components: string[] };
  vendors: VendorSpec[];
}

type Json = Record<string, unknown>;

function obj(raw: unknown, path: string): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`config: ${path} must be an object`);
  return raw as Json;
}

function arr(raw: unknown, path: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`config: ${path} must be an array`);
  return raw;
}

function str(o: Json, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new Error(`config: ${path}.${key} must be a non-empty string`);
  return v;
}

function strOrEmpty(o: Json, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`config: ${path}.${key} must be a string`);
  return v;
}

function int(o: Json, key: string, path: string, min: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Error(`config: ${path}.${key} must be an integer >= ${min}`);
  return v;
}

function httpsUrl(o: Json, key: string, path: string): string {
  const v = str(o, key, path);
  if (!v.startsWith('https://')) throw new Error(`config: ${path}.${key} must start with https://`);
  return v;
}

function strings(raw: unknown, path: string, min: number): string[] {
  const list = arr(raw, path);
  if (list.length < min) throw new Error(`config: ${path} must have at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
  return list.map((v, i) => {
    if (typeof v !== 'string' || v === '') throw new Error(`config: ${path}[${i}] must be a non-empty string`);
    return v;
  });
}

function feed(raw: unknown, path: string): FeedSpec {
  const f = obj(raw, path);
  switch (f.kind) {
    case 'statuspage':
    case 'slack':
      return { kind: f.kind, url: httpsUrl(f, 'url', path) };
    case 'google':
      return { kind: 'google', url: httpsUrl(f, 'url', path), products: strings(f.products, `${path}.products`, 1) };
    case 'none':
      return { kind: 'none' };
    default:
      throw new Error(`config: ${path}.kind must be statuspage, slack, google or none (feed.kind)`);
  }
}

function vendor(raw: unknown, path: string): VendorSpec {
  const v = obj(raw, path);
  const f = feed(v.feed, `${path}.feed`);
  let statusPageUrl: string | null;
  if (v.statusPageUrl === null) {
    if (f.kind !== 'none') throw new Error(`config: ${path}.statusPageUrl may be null only when feed.kind is none`);
    statusPageUrl = null;
  } else {
    statusPageUrl = httpsUrl(v, 'statusPageUrl', path);
  }
  return { name: str(v, 'name', path), usedFor: str(v, 'usedFor', path), statusPageUrl, feed: f };
}

function sync(raw: unknown, path: string): SyncSpec {
  const s = obj(raw, path);
  return {
    label: str(s, 'label', path),
    description: str(s, 'description', path),
    worker: str(s, 'worker', path),
    queues: strings(s.queues, `${path}.queues`, 0),
  };
}

export function validateConfig(raw: unknown): StatusConfig {
  const root = obj(raw, 'config');
  const access = obj(root.access, 'access');
  const cloudflare = obj(root.cloudflare, 'cloudflare');
  const hidden = obj(root.hiddenWorkers, 'hiddenWorkers');
  return {
    access: {
      teamDomain: strOrEmpty(access, 'teamDomain', 'access'),
      aud: strOrEmpty(access, 'aud', 'access'),
      allowedEmailDomain: str(access, 'allowedEmailDomain', 'access'),
    },
    timezone: str(root, 'timezone', 'config'),
    feedTimeoutMs: int(root, 'feedTimeoutMs', 'config', 1),
    feedCacheSeconds: int(root, 'feedCacheSeconds', 'config', 0),
    snapshotMaxAgeHours: int(root, 'snapshotMaxAgeHours', 'config', 1),
    syncs: arr(root.syncs, 'syncs').map((s, i) => sync(s, `syncs[${i}]`)),
    hiddenWorkers: Object.fromEntries(Object.keys(hidden).map((k) => [k, str(hidden, k, 'hiddenWorkers')])),
    cloudflare: {
      statusPageUrl: httpsUrl(cloudflare, 'statusPageUrl', 'cloudflare'),
      components: strings(cloudflare.components, 'cloudflare.components', 1),
    },
    vendors: arr(root.vendors, 'vendors').map((v, i) => vendor(v, `vendors[${i}]`)),
  };
}
