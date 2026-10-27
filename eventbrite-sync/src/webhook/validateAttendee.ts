import type { EventbriteSyncConfig } from '../types';
import { apiUrlRemainder, checkEnvelope } from './validate';

export type AttendeeDelivery =
  | { kind: 'event'; eventId: string; action: string }
  | { kind: 'attendee'; eventId: string; attendeeId: string; action: string };

export type AttendeeVerdict =
  | { kind: 'process'; delivery: AttendeeDelivery }
  | { kind: 'ignore'; reason: string };

/**
 * The event/attendee counterpart of `validateDelivery`: same payload shape, same throw-vs-ignore
 * rules, same organization check, but the actions come from `attendeeSync.actions` and `api_url`
 * must be `<apiUrl>/events/<digits>/` (an event) or `<apiUrl>/events/<digits>/attendees/<digits>/`
 * (an attendee). Only the ids are taken from it; the URL is never fetched.
 */
export function validateAttendeeDelivery(body: unknown, config: EventbriteSyncConfig): AttendeeVerdict {
  const envelope = checkEnvelope(body, config, config.attendeeSync.actions);
  if (envelope.kind === 'ignore') return envelope;
  const { action } = envelope;
  const ids = idsFromApiUrl(envelope.apiUrl, config.eventbrite.apiUrl);
  if (ids === null) {
    throw new Error(`eventbrite webhook: "api_url" is not an event or attendee URL under ${config.eventbrite.apiUrl}/events/`);
  }
  if (ids.attendeeId === null) {
    return { kind: 'process', delivery: { kind: 'event', eventId: ids.eventId, action } };
  }
  return { kind: 'process', delivery: { kind: 'attendee', eventId: ids.eventId, attendeeId: ids.attendeeId, action } };
}

export function idsFromApiUrl(apiUrl: string, baseUrl: string): { eventId: string; attendeeId: string | null } | null {
  const rest = apiUrlRemainder(apiUrl, baseUrl, 'events');
  const match = rest === null ? null : /^(\d+)(?:\/attendees\/(\d+))?\/?$/.exec(rest);
  return match === null ? null : { eventId: match[1]!, attendeeId: match[2] ?? null };
}
