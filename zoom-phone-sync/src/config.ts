import type { ZoomPhoneSyncConfig } from './types';

type Json = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new Error(`zoom-phone-sync config: ${path} must be ${expected}`);
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmptyString);

function section(raw: Json, key: string): Json {
  const value = raw[key];
  if (!isObject(value)) fail(key, 'an object');
  return value;
}

function nullableString(obj: Json, path: string, key: string): string | null {
  const value = obj[key];
  if (value === null) return null;
  if (!isNonEmptyString(value)) fail(`${path}.${key}`, 'a non-empty string or null');
  return value;
}

// Validates the shape once per isolate (src/environment.ts createConfigSelector). Throws on the
// first problem so a broken config fails every request loudly instead of half-working.
export function validateConfig(raw: unknown): ZoomPhoneSyncConfig {
  if (!isObject(raw)) fail('config', 'an object');

  const people = section(raw, 'people');
  if (typeof people.boardId !== 'number' || !Number.isInteger(people.boardId) || people.boardId <= 0) {
    fail('people.boardId', 'a positive integer');
  }
  if (!isNonEmptyString(people.phoneColumn)) fail('people.phoneColumn', 'a non-empty string');

  const timeline = section(raw, 'timeline');
  const zoom = section(raw, 'zoom');
  if (zoom.includeUsers !== null && !isStringArray(zoom.includeUsers)) fail('zoom.includeUsers', 'an array of strings or null');
  if (!isStringArray(zoom.excludeUsers)) fail('zoom.excludeUsers', 'an array of strings');
  const smsUrl = nullableString(zoom, 'zoom', 'smsUrl');
  if (smsUrl !== null && !smsUrl.startsWith('https://')) fail('zoom.smsUrl', 'an https:// URL or null');

  if (!isNonEmptyString(raw.defaultRegion)) fail('defaultRegion', 'a region code such as "US"');
  if (typeof raw.unmatchedRetentionDays !== 'number' || !(raw.unmatchedRetentionDays > 0)) {
    fail('unmatchedRetentionDays', 'a positive number');
  }

  return {
    people: {
      boardId: people.boardId as number,
      phoneColumn: people.phoneColumn as string,
      lastPhoneContactColumn: nullableString(people, 'people', 'lastPhoneContactColumn'),
    },
    timeline: {
      callActivityId: nullableString(timeline, 'timeline', 'callActivityId'),
      textActivityId: nullableString(timeline, 'timeline', 'textActivityId'),
    },
    zoom: {
      accountId: nullableString(zoom, 'zoom', 'accountId'),
      includeUsers: zoom.includeUsers as string[] | null,
      excludeUsers: zoom.excludeUsers as string[],
      smsUrl,
    },
    defaultRegion: raw.defaultRegion as string,
    unmatchedRetentionDays: raw.unmatchedRetentionDays as number,
  };
}
