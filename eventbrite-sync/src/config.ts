import type { EventbriteSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations:live', 'people-live', 'events', 'event-registrations'] as const;

// The placeholder config/svbc.json ships with, and config/sandbox.json's orderIdColumn carries
// until the Eventbrite Order ID column exists (README "Prerequisite column"). Validation accepts
// it — production config is allowed to be unconfigured — and the consumer refuses to write on it.
export const PLACEHOLDER_COLUMN_ID = 'REPLACE_WITH_COLUMN_ID';

const REQUIRED_COLUMN_KEYS = ['orderIdColumn', 'amountColumn', 'statusColumn', 'dateColumn', 'donorEmailColumn', 'donorLinkColumn'] as const;

// Column ids the consumer stamps on first write only. Each must be present so a fork opts out
// deliberately with null rather than by forgetting the key.
const NULLABLE_COLUMN_KEYS = {
  thankYouSentColumn: 'the Thank You Sent stamp',
  giftTypeColumn: 'the Gift Type stamp',
  fiscalYearColumn: 'the Fiscal Year Ending stamp',
} as const;

const ATTENDEE_EVENT_COLUMN_KEYS = [
  'eventbriteIdColumn', 'dateColumn', 'endColumn', 'venueColumn', 'addressColumn', 'cityColumn',
  'programColumn', 'eventStatusColumn', 'sourceColumn', 'urlColumn', 'classTypeColumn', 'followupsColumn',
] as const;
const ATTENDEE_REGISTRATION_COLUMN_KEYS = [
  'attendeeIdColumn', 'attendeeNameColumn', 'attendeeEmailColumn', 'firstNameColumn', 'attendanceColumn',
  'sourceColumn', 'roleColumn', 'eventLinkColumn', 'attendeeLinkColumn', 'classDateColumn', 'classDayColumn',
  'classLocationColumn', 'classTypeColumn', 'followupEmailColumn',
] as const;

const AMOUNT_SOURCES = ['gross', 'base_price'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

export function validateConfig(raw: unknown): EventbriteSyncConfig {
  if (!isObject(raw)) {
    throw new Error('config: expected an object');
  }
  const cfg = raw;

  if (!isObject(cfg.monday)) {
    throw new Error('config: missing required key "monday"');
  }
  const monday = cfg.monday;
  if (!isNonEmptyString(monday.apiUrl)) {
    throw new Error('config: missing required key "monday.apiUrl"');
  }
  if (!isObject(monday.boards)) {
    throw new Error('config: missing required key "monday.boards"');
  }
  for (const key of REQUIRED_BOARD_KEYS) {
    if (!(key in monday.boards)) {
      throw new Error(`config: missing required key "monday.boards.${key}"`);
    }
    const id = monday.boards[key];
    if (id !== null && (typeof id !== 'number' || !Number.isInteger(id))) {
      throw new Error(`config: "monday.boards.${key}" must be a Monday board id number, or null when unconfigured`);
    }
  }

  if (!isObject(cfg.eventbrite)) {
    throw new Error('config: missing required key "eventbrite"');
  }
  const eventbrite = cfg.eventbrite;
  if (!isNonEmptyString(eventbrite.apiUrl) || !/^https:\/\/[^/]+\/v3$/.test(eventbrite.apiUrl)) {
    throw new Error('config: "eventbrite.apiUrl" must be an https URL ending in /v3 with no trailing slash');
  }
  if (eventbrite.organizationId !== null && !isNonEmptyString(eventbrite.organizationId)) {
    throw new Error('config: "eventbrite.organizationId" must be the organization id as a string, or null to skip the check');
  }
  if (!Array.isArray(eventbrite.actions) || eventbrite.actions.length === 0 || eventbrite.actions.some((a) => !/^[a-z_]+\.[a-z_]+$/.test(String(a)))) {
    throw new Error('config: "eventbrite.actions" must be a non-empty array of webhook actions such as "order.placed"');
  }

  if (!isObject(cfg.eventbriteSync)) {
    throw new Error('config: missing required key "eventbriteSync"');
  }
  const sync = cfg.eventbriteSync;
  for (const key of REQUIRED_COLUMN_KEYS) {
    if (!isNonEmptyString(sync[key])) {
      throw new Error(`config: "eventbriteSync.${key}" must be a Monday column id string`);
    }
  }
  for (const [key, purpose] of Object.entries(NULLABLE_COLUMN_KEYS)) {
    if (!(key in sync) || (sync[key] !== null && !isNonEmptyString(sync[key]))) {
      throw new Error(`config: "eventbriteSync.${key}" must be a Monday column id string, or null to disable ${purpose}`);
    }
  }
  if (sync.giftTypeColumn !== null && !isNonEmptyString(sync.giftTypeValue)) {
    throw new Error('config: "eventbriteSync.giftTypeValue" must be a non-empty Gift Type label when giftTypeColumn is set');
  }
  if (!AMOUNT_SOURCES.includes(sync.amountSource as (typeof AMOUNT_SOURCES)[number])) {
    throw new Error(`config: "eventbriteSync.amountSource" must be one of ${AMOUNT_SOURCES.join(', ')}`);
  }
  if (typeof sync.skipFreeOrders !== 'boolean') {
    throw new Error('config: "eventbriteSync.skipFreeOrders" must be a boolean');
  }
  const statusLabelMap = sync.statusLabelMap;
  if (!isObject(statusLabelMap) || Object.keys(statusLabelMap).length === 0 || Object.values(statusLabelMap).some((v) => !isNonEmptyString(v))) {
    throw new Error('config: "eventbriteSync.statusLabelMap" must map Eventbrite order statuses to Donations Status labels');
  }
  if (!isNonEmptyString(sync.itemNameTemplate)) {
    throw new Error('config: "eventbriteSync.itemNameTemplate" must be a non-empty template such as "{buyer} - {event}"');
  }

  validateAttendeeSync(cfg.attendeeSync);

  return cfg as unknown as EventbriteSyncConfig;
}

function requireColumns(group: unknown, path: string, keys: readonly string[]): void {
  if (!isObject(group)) {
    throw new Error(`config: missing required key "${path}"`);
  }
  for (const key of keys) {
    if (!isNonEmptyString(group[key])) {
      throw new Error(`config: "${path}.${key}" must be a Monday column id string`);
    }
  }
}

function validateAttendeeSync(raw: unknown): void {
  if (!isObject(raw)) {
    throw new Error('config: missing required key "attendeeSync"');
  }
  const a = raw;
  if (!Array.isArray(a.actions) || a.actions.length === 0 || a.actions.some((x) => !/^[a-z_]+\.[a-z_]+$/.test(String(x)))) {
    throw new Error('config: "attendeeSync.actions" must be a non-empty array of webhook actions such as "attendee.updated"');
  }
  if (!isObject(a.programByOrganizer) || Object.values(a.programByOrganizer).some((v) => !isNonEmptyString(v))) {
    throw new Error('config: "attendeeSync.programByOrganizer" must map Eventbrite organizer ids to Program labels');
  }
  if (!Array.isArray(a.volunteerPrograms) || a.volunteerPrograms.some((v) => !isNonEmptyString(v))) {
    throw new Error('config: "attendeeSync.volunteerPrograms" must be an array of Program labels');
  }
  requireColumns(a.events, 'attendeeSync.events', ATTENDEE_EVENT_COLUMN_KEYS);
  requireColumns(a.registrations, 'attendeeSync.registrations', ATTENDEE_REGISTRATION_COLUMN_KEYS);
  requireColumns(a, 'attendeeSync', ['peopleEmailColumn']);

  if (!isObject(a.followups)) {
    throw new Error('config: missing required key "attendeeSync.followups"');
  }
  const f = a.followups;
  if (typeof f.maxAgeDays !== 'number' || !Number.isFinite(f.maxAgeDays) || f.maxAgeDays <= 0) {
    throw new Error('config: "attendeeSync.followups.maxAgeDays" must be a positive number of days');
  }
  if (typeof f.sendHourLocal !== 'number' || !Number.isInteger(f.sendHourLocal) || f.sendHourLocal < 0 || f.sendHourLocal > 23) {
    throw new Error('config: "attendeeSync.followups.sendHourLocal" must be an integer hour from 0 to 23');
  }
  if (f.notifyUserId !== null && (typeof f.notifyUserId !== 'number' || !Number.isInteger(f.notifyUserId))) {
    throw new Error('config: "attendeeSync.followups.notifyUserId" must be a Monday user id number, or null to skip the notification');
  }
}
