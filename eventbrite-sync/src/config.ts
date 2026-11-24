import type { EventbriteSyncConfig } from './types';

const REQUIRED_BOARD_KEYS = ['donations:live', 'people-live', 'events', 'event-registrations', 'volunteers'] as const;

// The placeholder config/svbc.json ships with, and config/sandbox.json's orderIdColumn carries
// until the Eventbrite Order ID column exists (README "Prerequisite column"). Validation accepts
// it — production config is allowed to be unconfigured — and the consumer refuses to write on it.
export const PLACEHOLDER_COLUMN_ID = 'REPLACE_WITH_COLUMN_ID';

const REQUIRED_COLUMN_KEYS = ['orderIdColumn', 'amountColumn', 'statusColumn', 'dateColumn', 'donorEmailColumn', 'donorFirstNameColumn', 'donorLastNameColumn', 'donorLinkColumn'] as const;

// Column ids the consumer stamps on first write only. Each must be present so a fork opts out
// deliberately with null rather than by forgetting the key.
const NULLABLE_COLUMN_KEYS = {
  thankYouSentColumn: 'the Thank You Sent stamp',
  giftTypeColumn: 'the Gift Type stamp',
  fiscalYearColumn: 'the Fiscal Year Ending stamp',
} as const;

const ATTENDEE_EVENT_COLUMN_KEYS = [
  'eventbriteIdColumn', 'dateColumn', 'endColumn', 'venueColumn', 'addressColumn', 'cityColumn',
  'programColumn', 'eventStatusColumn', 'sourceColumn', 'urlColumn', 'sendLinkColumn',
] as const;
const ATTENDEE_REGISTRATION_COLUMN_KEYS = [
  'attendeeIdColumn', 'attendeeNameColumn', 'attendeeEmailColumn', 'attendeePhoneColumn', 'firstNameColumn', 'attendanceColumn',
  'sourceColumn', 'roleColumn', 'eventLinkColumn', 'attendeeLinkColumn', 'classDateColumn', 'classDayColumn',
  'classLocationColumn', 'homeZipColumn', 'registrantsLinkColumn',
] as const;

const VOLUNTEER_COLUMN_KEYS = [
  'attendeeIdColumn', 'attendeeNameColumn', 'attendeeEmailColumn', 'jobColumn', 'dateColumn', 'statusColumn',
  'historicalColumn', 'volunteerLinkColumn', 'eventColumn', 'listingColumn', 'ticketTypeColumn',
  'attendeePhoneColumn',
] as const;

// The Volunteers board columns this Worker added (setup-volunteers-board.mjs creates them); the
// other five attendeeSync.volunteers columns already existed. config/svbc.json carries the
// placeholder in all five until the cutover (docs/runbooks/volunteers-board-cutover.md step 2).
// ticketTypeColumn (GL#115) and attendeePhoneColumn are new too but optional: their placeholders only
// skip the ticket class and the phone, so they aren't part of the switch.
export const NEW_VOLUNTEER_COLUMN_KEYS = ['eventColumn', 'listingColumn', 'attendeeIdColumn', 'attendeeNameColumn', 'attendeeEmailColumn'] as const;

export type VolunteerBoardMode = 'legacy' | 'ready';

// Where a volunteer event's sign-ups live, decided by config alone so a deploy from main before the
// cutover changes nothing. legacy: all five new columns are the placeholder, so volunteer sign-ups
// and their class emails stay on Event Registrations (Role = Volunteer), as before the Volunteers
// board feed. ready: the board is set and all five are real. Anything in between throws: a
// half-configured cutover must never quietly split one event's volunteers across two boards.
export function volunteerBoardMode(config: EventbriteSyncConfig): VolunteerBoardMode {
  const cols = config.attendeeSync.volunteers;
  const placeholders = NEW_VOLUNTEER_COLUMN_KEYS.filter((key) => cols[key] === PLACEHOLDER_COLUMN_ID);
  if (placeholders.length === NEW_VOLUNTEER_COLUMN_KEYS.length) return 'legacy';
  if (placeholders.length > 0) {
    throw new Error(`config: the Volunteers board is half-configured — attendeeSync.volunteers ${placeholders.join(', ')} still the placeholder; set all five new column ids (or none) before deploying`);
  }
  if (config.monday.boards.volunteers === null) {
    throw new Error('config: the Volunteers board is half-configured — attendeeSync.volunteers columns are set but monday.boards.volunteers is null');
  }
  return 'ready';
}

const PLEDGE_COLUMN_KEYS = [
  'attendeeIdColumn', 'yearColumn', 'statusColumn', 'dateColumn', 'emailColumn', 'detailsColumn', 'zipColumn', 'countyColumn',
  'daysPledgedColumn', 'riderTypeColumn', 'heardAboutColumn', 'whoAskedColumn', 'consentColumn', 'otherAnswersColumn',
] as const;
const PLEDGE_FIELDS = ['zip', 'daysPledged', 'riderType', 'heardAbout', 'whoAsked', 'consent', 'employer'];
// The county labels mapPledge assigns itself.
const PLEDGE_FALLBACK_COUNTIES = ['Outside', 'Unknown'];

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
  if (typeof sync.currency !== 'string' || !/^[A-Z]{3}$/.test(sync.currency)) {
    throw new Error('config: "eventbriteSync.currency" must be the Donations board\'s ISO 4217 currency code, such as "USD"');
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
  if (cfg.pledge !== undefined) validatePledge(cfg.pledge, monday.boards);
  if (!isObject(cfg.employerAnswers) || typeof cfg.employerAnswers.enabled !== 'boolean') {
    throw new Error('config: "employerAnswers.enabled" must be a boolean (false keeps employer answers from being handed to impact-attribution)');
  }

  const config = cfg as unknown as EventbriteSyncConfig;
  volunteerBoardMode(config); // a half-configured Volunteers board fails here, at load (and in CI)
  return config;
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
  if (!Array.isArray(a.zipPrograms) || a.zipPrograms.some((v) => !isNonEmptyString(v))) {
    throw new Error('config: "attendeeSync.zipPrograms" must be an array of Program labels');
  }
  requireColumns(a.events, 'attendeeSync.events', ATTENDEE_EVENT_COLUMN_KEYS);
  requireColumns(a.registrations, 'attendeeSync.registrations', ATTENDEE_REGISTRATION_COLUMN_KEYS);
  requireColumns(a.volunteers, 'attendeeSync.volunteers', VOLUNTEER_COLUMN_KEYS);
  requireColumns(a, 'attendeeSync', ['peopleEmailColumn']);
  if (!Array.isArray(a.registrantsLinkExcludedEventIds) || a.registrantsLinkExcludedEventIds.some((id) => typeof id !== 'string')) {
    throw new Error('config: "attendeeSync.registrantsLinkExcludedEventIds" must be an array of Eventbrite event ids');
  }
  if (!isObject(a.classEmails)) {
    throw new Error('config: missing required key "attendeeSync.classEmails"');
  }
  const { pageUrl, sandboxRecipient, timelineActivityId } = a.classEmails;
  if (pageUrl !== null && !(typeof pageUrl === 'string' && /^https:\/\/[^\s/]+\S*$/.test(pageUrl))) {
    throw new Error('config: "attendeeSync.classEmails.pageUrl" must be an https URL, or null until the page is deployed');
  }
  if (sandboxRecipient !== null && !(typeof sandboxRecipient === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sandboxRecipient))) {
    throw new Error('config: "attendeeSync.classEmails.sandboxRecipient" must be an email address, or null');
  }
  if (timelineActivityId !== null && !(typeof timelineActivityId === 'string' && timelineActivityId.trim() !== '')) {
    throw new Error('config: "attendeeSync.classEmails.timelineActivityId" must be a custom activity id, or null to post no timeline entries');
  }
  // mapEvent writes the link whenever pageUrl is set, so the placeholder would reach Monday as a column id.
  if (pageUrl !== null && (a.events as Record<string, unknown>).sendLinkColumn === PLACEHOLDER_COLUMN_ID) {
    throw new Error('config: "attendeeSync.events.sendLinkColumn" must be a real Monday column id when "attendeeSync.classEmails.pageUrl" is set');
  }
}

function validatePledge(raw: unknown, boards: Record<string, unknown>): void {
  if (!isObject(raw)) {
    throw new Error('config: "pledge" must be an object');
  }
  const board = boards['pledge-to-ride'];
  if (board !== null && (typeof board !== 'number' || !Number.isInteger(board))) {
    throw new Error('config: "monday.boards.pledge-to-ride" must be a Monday board id number, or null when unconfigured, when "pledge" is set');
  }
  if (!isNonEmptyString(raw.nameMatch)) {
    throw new Error('config: "pledge.nameMatch" must be a non-empty string');
  }
  requireColumns(raw.columns, 'pledge.columns', PLEDGE_COLUMN_KEYS);
  if (!isObject(raw.zipCounty)) {
    throw new Error('config: "pledge.zipCounty" must map county labels to arrays of 5-digit zips');
  }
  const seen = new Set<string>();
  for (const [county, zips] of Object.entries(raw.zipCounty)) {
    if (PLEDGE_FALLBACK_COUNTIES.includes(county)) {
      throw new Error(`config: "pledge.zipCounty.${county}" can't be listed: it means a zip on no list`);
    }
    if (!Array.isArray(zips) || zips.some((zip) => typeof zip !== 'string' || !/^\d{5}$/.test(zip))) {
      throw new Error(`config: "pledge.zipCounty.${county}" must be an array of 5-digit zips`);
    }
    for (const zip of zips as string[]) {
      if (seen.has(zip)) throw new Error(`config: zip ${zip} is under more than one county in "pledge.zipCounty"`);
      seen.add(zip);
    }
  }
  if (!isObject(raw.events)) {
    throw new Error('config: "pledge.events" must map Eventbrite event ids to their setup');
  }
  for (const [eventId, event] of Object.entries(raw.events)) {
    validatePledgeEvent(eventId, event);
  }
}

function validatePledgeEvent(eventId: string, event: unknown): void {
  const path = `pledge.events.${eventId}`;
  if (!/^\d+$/.test(eventId)) {
    throw new Error(`config: "${path}" must be keyed by a numeric Eventbrite event id`);
  }
  if (!isObject(event)) {
    throw new Error(`config: "${path}" must be an object`);
  }
  if (typeof event.year !== 'number' || !Number.isInteger(event.year)) {
    throw new Error(`config: "${path}.year" must be an integer`);
  }
  if (!isObject(event.questions)) {
    throw new Error(`config: "${path}.questions" must map question ids to fields`);
  }
  for (const [questionId, field] of Object.entries(event.questions)) {
    if (!/^\d+$/.test(questionId) || !PLEDGE_FIELDS.includes(field as string)) {
      throw new Error(`config: "${path}.questions.${questionId}" must be a numeric question id mapped to one of ${PLEDGE_FIELDS.join(', ')}`);
    }
  }
  if (!Array.isArray(event.ignoreQuestions) || event.ignoreQuestions.some((id) => typeof id !== 'string')) {
    throw new Error(`config: "${path}.ignoreQuestions" must be an array of question ids`);
  }
  if (!isObject(event.choices) || Object.values(event.choices).some((label) => !isNonEmptyString(label))) {
    throw new Error(`config: "${path}.choices" must map Eventbrite's answer text to non-empty labels`);
  }
  if (!Array.isArray(event.consentValues) || event.consentValues.some((value) => typeof value !== 'string')) {
    throw new Error(`config: "${path}.consentValues" must be an array of answer strings`);
  }
}
