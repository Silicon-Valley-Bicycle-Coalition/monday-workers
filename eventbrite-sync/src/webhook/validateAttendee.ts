import type { EventbriteSyncConfig } from '../types';

export type AttendeeDelivery =
  | { kind: 'event'; eventId: string; action: string }
  | { kind: 'attendee'; eventId: string; attendeeId: string; action: string };

export type AttendeeVerdict =
  | { kind: 'process'; delivery: AttendeeDelivery }
  | { kind: 'ignore'; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The event/attendee counterpart of `validateDelivery`: same payload shape, same throw-vs-ignore
 * rules, same organization check, but the actions come from `attendeeSync.actions` and `api_url`
 * must be `<apiUrl>/events/<digits>/` (an event) or `<apiUrl>/events/<digits>/attendees/<digits>/`
 * (an attendee). Only the ids are taken from it; the URL is never fetched.
 */
export function validateAttendeeDelivery(body: unknown, config: EventbriteSyncConfig): AttendeeVerdict {
  if (!isObject(body)) {
    throw new Error('eventbrite webhook: payload must be a JSON object');
  }
  if (!isObject(body.config) || typeof body.config.action !== 'string' || body.config.action === '') {
    throw new Error('eventbrite webhook: payload missing "config.action"');
  }
  const action = body.config.action;
  if (!config.attendeeSync.actions.includes(action)) {
    return { kind: 'ignore', reason: `action "${action}" is not subscribed` };
  }

  const rawUserId = body.config.user_id;
  const organizationId = typeof rawUserId === 'string' && rawUserId !== '' ? rawUserId : typeof rawUserId === 'number' ? String(rawUserId) : null;
  if (config.eventbrite.organizationId !== null && organizationId !== null && organizationId !== config.eventbrite.organizationId) {
    return { kind: 'ignore', reason: `config.user_id "${organizationId}" is not the configured organization` };
  }

  if (typeof body.api_url !== 'string' || body.api_url === '') {
    throw new Error('eventbrite webhook: payload missing "api_url"');
  }
  const ids = idsFromApiUrl(body.api_url, config.eventbrite.apiUrl);
  if (ids === null) {
    throw new Error(`eventbrite webhook: "api_url" is not an event or attendee URL under ${config.eventbrite.apiUrl}/events/`);
  }
  if (ids.attendeeId === null) {
    return { kind: 'process', delivery: { kind: 'event', eventId: ids.eventId, action } };
  }
  return { kind: 'process', delivery: { kind: 'attendee', eventId: ids.eventId, attendeeId: ids.attendeeId, action } };
}

// Parsed and compared like orderIdFromApiUrl: no query, hash or credentials, and the origin plus
// path must start with the configured base, so look-alike hosts and `..` tricks both fail.
export function idsFromApiUrl(apiUrl: string, baseUrl: string): { eventId: string; attendeeId: string | null } | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null;
  const prefix = `${baseUrl}/events/`;
  const normalized = `${url.origin}${url.pathname}`;
  if (!normalized.startsWith(prefix)) return null;
  const match = /^(\d+)(?:\/attendees\/(\d+))?\/?$/.exec(normalized.slice(prefix.length));
  return match === null ? null : { eventId: match[1]!, attendeeId: match[2] ?? null };
}
