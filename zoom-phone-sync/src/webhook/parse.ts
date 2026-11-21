// Zoom Phone webhook payload → the events this Worker stores, with everything else dropped here.
// Field names follow the design's reading of Zoom's events reference
// (docs/superpowers/specs/2026-11-19-zoom-phone-sync-design.md, "Fields used"); the SMS ones were
// taken from a summary and are confirmed against real deliveries in #50. Until then the readers
// below accept both the flat (`caller_did_number`) and nested (`caller.did_number`) spellings.
//
// Nothing in this file copies an SMS's `message`: each event is rebuilt from named fields only, so
// the text can't ride along into D1, the queue or a log.
import type { ZoomPhoneSyncConfig } from '../types';

export const CALL_EVENTS = ['phone.caller_call_element_completed', 'phone.callee_call_element_completed'] as const;
export const SMS_EVENTS = ['phone.sms_sent', 'phone.sms_received'] as const;
export type SubscribedEvent = (typeof CALL_EVENTS)[number] | (typeof SMS_EVENTS)[number];

export function isSubscribedEvent(name: unknown): name is SubscribedEvent {
  return (CALL_EVENTS as readonly unknown[]).includes(name) || (SMS_EVENTS as readonly unknown[]).includes(name);
}

export type Direction = 'inbound' | 'outbound';

// One call element or one text, as stored in phone_events.
export interface PhoneEvent {
  eventId: string;
  kind: 'call' | 'text';
  callId: string | null;
  occurredAt: string;
  zoomUserId: string;
  // The staff party's display name as Zoom gives it; null when absent.
  staffName: string | null;
  externalE164: string;
  direction: Direction;
  result: string | null;
  talkSeconds: number | null;
}

export type SkipReason = 'internal' | 'excluded' | 'noExternalNumber' | 'malformed';

export interface ParsedDelivery {
  events: PhoneEvent[];
  skipped: Record<SkipReason, number>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);

/**
 * A phone number as E.164, or null when there isn't a usable one (blocked, anonymous, an
 * extension). Zoom sends E.164 already; formatting characters are tolerated, and a bare 10-digit
 * number (or 11 starting with 1) is read as North American when the region is US.
 */
export function toE164(value: unknown, region: string): string | null {
  const raw = str(value);
  if (raw === null) return null;
  const plus = raw.startsWith('+');
  const digits = raw.replace(/[\s().-]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  if (plus) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  if (region === 'US' && /^[2-9]\d{9}$/.test(digits)) return `+1${digits}`;
  if (region === 'US' && /^1[2-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

// A call party's fields, flat (`caller_did_number`) or nested (`caller: { did_number }`).
function party(element: Json, side: 'caller' | 'callee'): Json {
  const nested = isObject(element[side]) ? (element[side] as Json) : {};
  const field = (name: string): unknown => element[`${side}_${name}`] ?? nested[name];
  return {
    did_number: field('did_number'),
    phone_number: field('phone_number') ?? field('number'),
    ext_number: field('ext_number') ?? field('extension_number'),
    email: field('email'),
    name: field('name') ?? nested.display_name,
    user_id: field('user_id') ?? nested.id,
  };
}

// Every identifier a staff party could be listed under in includeUsers/excludeUsers.
function identifiers(...values: unknown[]): string[] {
  return values.map(str).filter((v): v is string => v !== null);
}

function allowed(ids: string[], zoom: ZoomPhoneSyncConfig['zoom']): boolean {
  const lower = new Set(ids.map((id) => id.toLowerCase()));
  const listed = (list: string[]) => list.some((entry) => lower.has(entry.toLowerCase()));
  if (zoom.includeUsers !== null && !listed(zoom.includeUsers)) return false;
  return !listed(zoom.excludeUsers);
}

function isoTime(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function emptySkips(): Record<SkipReason, number> {
  return { internal: 0, excluded: 0, noExternalNumber: 0, malformed: 0 };
}

function callElements(object: Json): unknown[] {
  return Array.isArray(object.call_elements) ? object.call_elements : [object];
}

function parseCall(event: (typeof CALL_EVENTS)[number], raw: unknown, config: ZoomPhoneSyncConfig): PhoneEvent | SkipReason {
  if (!isObject(raw)) return 'malformed';
  const eventId = str(raw.call_element_id);
  const occurredAt = isoTime(raw.start_time);
  if (eventId === null || occurredAt === null) return 'malformed';
  if (str(raw.connect_type)?.toLowerCase() === 'internal') return 'internal';

  // The subscribed side is the staff line: the caller on a caller_ event, the callee on a callee_ one.
  const staffSide = event === 'phone.caller_call_element_completed' ? 'caller' : 'callee';
  const staff = party(raw, staffSide);
  const other = party(raw, staffSide === 'caller' ? 'callee' : 'caller');
  const staffIds = identifiers(raw.user_id, staff.user_id, staff.email, staff.ext_number);
  if (!allowed(staffIds, config.zoom)) return 'excluded';

  const externalE164 = toE164(other.did_number, config.defaultRegion) ?? toE164(other.phone_number, config.defaultRegion);
  if (externalE164 === null) return 'noExternalNumber';

  const direction = str(raw.direction)?.toLowerCase();
  const talk = Number(raw.talk_time);
  return {
    eventId,
    kind: 'call',
    callId: str(raw.call_id),
    occurredAt,
    zoomUserId: staffIds[0] ?? 'unknown',
    staffName: str(staff.name),
    externalE164,
    direction: direction === 'inbound' || direction === 'outbound' ? direction : staffSide === 'caller' ? 'outbound' : 'inbound',
    result: str(raw.result),
    talkSeconds: Number.isFinite(talk) && talk >= 0 ? Math.round(talk) : null,
  };
}

function parseText(event: (typeof SMS_EVENTS)[number], raw: Json, config: ZoomPhoneSyncConfig): PhoneEvent | SkipReason {
  const eventId = str(raw.message_id);
  const occurredAt = isoTime(raw.date_time);
  if (eventId === null || occurredAt === null) return 'malformed';

  const owner = isObject(raw.owner) ? raw.owner : {};
  const sender = isObject(raw.sender) ? raw.sender : {};
  const members = (Array.isArray(raw.to_members) ? raw.to_members : []).filter(isObject);
  const sent = event === 'phone.sms_sent';

  // owner is the staff line (a user, call queue or auto receptionist) in both directions.
  const staffIds = sent
    ? identifiers(owner.id, sender.user_id, sender.id, owner.email, sender.email)
    : identifiers(owner.id, ...members.flatMap((m) => [m.user_id, m.id]), owner.email);
  if (!allowed(staffIds, config.zoom)) return 'excluded';

  // A text to several people logs against the first external number. Group texts are rare on staff
  // lines; revisit if the fixtures in #50 show otherwise.
  const externalE164 = sent
    ? members.map((m) => toE164(m.phone_number, config.defaultRegion)).find((n) => n !== null) ?? null
    : toE164(sender.phone_number, config.defaultRegion);
  if (externalE164 === null) return 'noExternalNumber';

  return {
    eventId,
    kind: 'text',
    callId: null,
    occurredAt,
    zoomUserId: staffIds[0] ?? 'unknown',
    // owner.name is the line's name (a user, or a call queue's name); the staff party's own
    // display name is the fallback.
    staffName: str(owner.name) ?? (sent ? str(sender.display_name) : members.map((m) => str(m.display_name)).find((n) => n !== null) ?? null),
    externalE164,
    direction: sent ? 'outbound' : 'inbound',
    result: null,
    talkSeconds: null,
  };
}

/**
 * The stored events in one delivery, and a count of what was dropped and why. `payload` is the
 * delivery's `payload` member. A call delivery may carry several elements; a text carries one.
 */
export function parseDelivery(event: SubscribedEvent, payload: unknown, config: ZoomPhoneSyncConfig): ParsedDelivery {
  const out: ParsedDelivery = { events: [], skipped: emptySkips() };
  const object = isObject(payload) && isObject(payload.object) ? payload.object : null;
  if (object === null) {
    out.skipped.malformed += 1;
    return out;
  }
  const results = (CALL_EVENTS as readonly string[]).includes(event)
    ? callElements(object).map((el) => parseCall(event as (typeof CALL_EVENTS)[number], el, config))
    : [parseText(event as (typeof SMS_EVENTS)[number], object, config)];
  for (const result of results) {
    if (typeof result === 'string') out.skipped[result] += 1;
    else out.events.push(result);
  }
  return out;
}
