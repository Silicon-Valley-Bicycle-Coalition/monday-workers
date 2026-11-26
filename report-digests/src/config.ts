// Validates a config/*.json at startup so a placeholder or a typo fails the first run, not a
// silent Monday morning. Board ids of 0 are allowed (the production file until cutover) — a digest
// against a 0 board fails loudly at the board read instead.

export const DIGEST_KEYS = ['unmatched-gifts', 'renewals', 'recent-gifts', 'fiscal-year-by-size', 'last-week', 'receipt-review'] as const;
export type DigestKey = (typeof DIGEST_KEYS)[number];
// A digest an environment may leave out of its config: never due, and the operator route refuses it.
const OPTIONAL_KEYS = ['receipt-review'] as const;
type OptionalKey = (typeof OPTIONAL_KEYS)[number];

// Pacific wall-clock schedule. weekdays: 0 = Sunday … 6 = Saturday. monthDays: 1–31. A digest
// names one or the other; hour is 0–23.
export interface Schedule { weekdays?: number[]; monthDays?: number[]; hour: number }

export interface DigestConfig {
  schedule: Schedule;
  recipients: number[]; // Monday user ids; emails are looked up at send time, so none sit in this public repo
  view: string;         // the board view the email links to, by name (configure creates it)
  skipWhenEmpty: boolean;
  days: number | null;      // look-back window, for the digests that have one
  minAmount: number | null; // the recent-gifts digest's "$400 and up" floor
  unthankedDays: number | null; // receipt-review's look-back for gifts with Thank You Sent unticked
}

export interface DigestsConfig {
  monday: { apiUrl: string; accountUrl: string };
  timeZone: string;
  fromAddress: string;
  fromName: string;
  logoUrl: string;
  // The only domains a digest may be emailed to (GL#70): a recipient's Monday address outside them
  // is dropped, since production's EMAIL binding has no allowed_destination_addresses.
  recipientDomains: string[];
  boards: { donations: number; people: number };
  digests: Record<Exclude<DigestKey, OptionalKey>, DigestConfig> & Partial<Record<OptionalKey, DigestConfig>>;
}

type Json = Record<string, unknown>;

function obj(raw: unknown, path: string): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`config: ${path} must be an object`);
  return raw as Json;
}

function str(o: Json, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new Error(`config: ${path}.${key} must be a non-empty string`);
  return v;
}

function int(o: Json, key: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`config: ${path}.${key} must be an integer ${min}–${max}`);
  return v;
}

function optionalInt(o: Json, key: string, path: string, min: number): number | null {
  return o[key] === undefined || o[key] === null ? null : int(o, key, path, min);
}

function intList(o: Json, key: string, path: string, min: number, max: number): number[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.some((n) => !Number.isInteger(n) || n < min || n > max)) {
    throw new Error(`config: ${path}.${key} must be a non-empty array of integers ${min}–${max}`);
  }
  return v as number[];
}

// Bare lowercase domains, matched exactly against the part after the address's last @.
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function domainList(o: Json, key: string, path: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.length === 0 || v.some((d) => typeof d !== 'string' || !DOMAIN.test(d))) {
    throw new Error(`config: ${path}.${key} must be a non-empty array of lowercase domains, without @`);
  }
  return v as string[];
}

function schedule(raw: unknown, path: string): Schedule {
  const o = obj(raw, path);
  const weekdays = intList(o, 'weekdays', path, 0, 6);
  const monthDays = intList(o, 'monthDays', path, 1, 31);
  if ((weekdays === undefined) === (monthDays === undefined)) throw new Error(`config: ${path} needs exactly one of weekdays or monthDays`);
  return { ...(weekdays ? { weekdays } : { monthDays }), hour: int(o, 'hour', path, 0, 23) };
}

function digest(raw: unknown, path: string): DigestConfig {
  const o = obj(raw, path);
  const recipients = intList(o, 'recipients', path, 1, Number.MAX_SAFE_INTEGER);
  if (recipients === undefined) throw new Error(`config: ${path}.recipients must be a non-empty array of Monday user ids`);
  return {
    schedule: schedule(o.schedule, `${path}.schedule`),
    recipients,
    view: str(o, 'view', path),
    skipWhenEmpty: o.skipWhenEmpty === true,
    days: optionalInt(o, 'days', path, 1),
    minAmount: optionalInt(o, 'minAmount', path, 0),
    unthankedDays: optionalInt(o, 'unthankedDays', path, 1),
  };
}

export function validateConfig(raw: unknown): DigestsConfig {
  const root = obj(raw, 'root');
  const monday = obj(root.monday, 'monday');
  const boards = obj(root.boards, 'boards');
  const digests = obj(root.digests, 'digests');
  const unknown = Object.keys(digests).filter((k) => !(DIGEST_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error(`config: digests has unknown keys: ${unknown.join(', ')}`);

  const config: DigestsConfig = {
    monday: { apiUrl: str(monday, 'apiUrl', 'monday'), accountUrl: str(monday, 'accountUrl', 'monday') },
    timeZone: str(root, 'timeZone', 'root'),
    fromAddress: str(root, 'fromAddress', 'root'),
    fromName: str(root, 'fromName', 'root'),
    logoUrl: str(root, 'logoUrl', 'root'),
    recipientDomains: domainList(root, 'recipientDomains', 'root'),
    boards: { donations: int(boards, 'donations', 'boards', 0), people: int(boards, 'people', 'boards', 0) },
    digests: Object.fromEntries(
      DIGEST_KEYS.filter((key) => digests[key] !== undefined || !(OPTIONAL_KEYS as readonly string[]).includes(key))
        .map((key) => [key, digest(digests[key], `digests.${key}`)])
    ) as DigestsConfig['digests'],
  };
  for (const key of ['recent-gifts', 'last-week'] as const) {
    if (config.digests[key].days === null) throw new Error(`config: digests.${key}.days is required`);
  }
  if (config.digests['recent-gifts'].minAmount === null) throw new Error('config: digests.recent-gifts.minAmount is required');
  const review = config.digests['receipt-review'];
  if (review) {
    for (const key of ['days', 'unthankedDays'] as const) {
      if (review[key] === null) throw new Error(`config: digests.receipt-review.${key} is required`);
    }
  }
  // Throws on an unknown zone, here rather than at the first cron.
  new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone });
  return config;
}
