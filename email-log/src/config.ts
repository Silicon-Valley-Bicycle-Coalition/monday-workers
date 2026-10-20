import type { EmailLogConfig } from './types';

// Config ships unconfigured: column ids and the authserv-id carry these placeholders until the
// boards exist / live mail shows the real value. Validation accepts them — production config is
// allowed to be unconfigured — and the consumers refuse to write (or fail closed) while set.
export const PLACEHOLDER_COLUMN_ID = 'REPLACE_WITH_COLUMN_ID';
export const PLACEHOLDER_AUTHSERV_ID = 'REPLACE_WITH_AUTHSERV_ID';

const BOARD_KEYS = ['activities-logged', 'people-live', 'people-historical', 'affiliations'] as const;
const ACTIVITY_STRING_KEYS = [
  'activityTypeColumn',
  'activityTypeLabel',
  'dateColumn',
  'statusColumn',
  'doneLabel',
  'needsPersonLabel',
  'ownerColumn',
  'personColumn',
  'notesColumn',
  'messageHashColumn',
] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmptyString);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function section(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = parent[key];
  if (!isObject(value)) throw new Error(`config: missing required key "${path}"`);
  return value;
}

function nullableString(obj: Record<string, unknown>, key: string, path: string): void {
  if (!(key in obj) || (obj[key] !== null && !isNonEmptyString(obj[key]))) {
    throw new Error(`config: "${path}" must be a Monday column id string, or null when unconfigured`);
  }
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(raw: unknown): EmailLogConfig {
  if (!isObject(raw)) throw new Error('config: expected an object');

  const monday = section(raw, 'monday', 'monday');
  if (!isNonEmptyString(monday.apiUrl)) throw new Error('config: missing required key "monday.apiUrl"');
  if (!isNonEmptyString(monday.accountUrl) || !/^https:\/\/[^/]+$/.test(monday.accountUrl)) {
    throw new Error('config: "monday.accountUrl" must be an https origin with no trailing slash');
  }
  const boards = section(monday, 'boards', 'monday.boards');
  for (const key of BOARD_KEYS) {
    if (!(key in boards)) throw new Error(`config: missing required key "monday.boards.${key}"`);
    const id = boards[key];
    if (id !== null && !isPositiveInt(id)) {
      throw new Error(`config: "monday.boards.${key}" must be a Monday board id number, or null when unconfigured`);
    }
  }

  const activities = section(raw, 'activities', 'activities');
  for (const key of ACTIVITY_STRING_KEYS) {
    if (!isNonEmptyString(activities[key])) {
      throw new Error(`config: "activities.${key}" must be a non-empty string (a Monday column id or status label)`);
    }
  }

  const matching = section(raw, 'matching', 'matching');
  for (const key of ['peopleEmailColumns', 'historicalEmailColumns'] as const) {
    if (!isStringArray(matching[key]) || matching[key].length === 0) {
      throw new Error(`config: "matching.${key}" must be a non-empty array of Monday column ids`);
    }
  }
  nullableString(matching, 'affiliationsWorkEmailColumn', 'matching.affiliationsWorkEmailColumn');
  nullableString(matching, 'affiliationsPersonColumn', 'matching.affiliationsPersonColumn');

  const mail = section(raw, 'mail', 'mail');
  if (!isNonEmptyString(mail.loggingAddress) || !/^[^@\s]+@[^@\s]+$/.test(mail.loggingAddress)) {
    throw new Error('config: "mail.loggingAddress" must be an email address');
  }
  if (!isStringArray(mail.staffDomains) || mail.staffDomains.length === 0) {
    throw new Error('config: "mail.staffDomains" must be a non-empty array of domains');
  }
  if (!isStringArray(mail.staffSenders)) {
    throw new Error('config: "mail.staffSenders" must be an array of addresses ([] allows the whole staff domain)');
  }
  // Staff means exact domain equality, so a logging subdomain (log.example.org) is fine, but the
  // logging address on a staff domain itself would make the Worker treat its own address as staff.
  const loggingDomain = mail.loggingAddress.slice(mail.loggingAddress.lastIndexOf('@') + 1).toLowerCase();
  if (mail.staffDomains.some((d) => d.toLowerCase() === loggingDomain)) {
    throw new Error(`config: "mail.loggingAddress" must not be on a staff domain (${loggingDomain}); use a dedicated subdomain`);
  }
  if (!isNonEmptyString(mail.trustedAuthServId)) {
    throw new Error('config: "mail.trustedAuthServId" must be the authserv-id of the trusted Authentication-Results header');
  }
  if (typeof mail.bodyMaxChars !== 'number' || !Number.isInteger(mail.bodyMaxChars) || mail.bodyMaxChars < 200 || mail.bodyMaxChars > 1950) {
    throw new Error('config: "mail.bodyMaxChars" must be an integer from 200 to 1950');
  }
  if (!isPositiveInt(mail.maxRawBytes)) throw new Error('config: "mail.maxRawBytes" must be a positive integer');
  if (!isNonEmptyString(mail.forwardTimeZone) || !isValidTimeZone(mail.forwardTimeZone)) {
    throw new Error('config: "mail.forwardTimeZone" must be an IANA time zone such as "America/Los_Angeles"');
  }
  const replyFrom = section(mail, 'replyFrom', 'mail.replyFrom');
  if (!isNonEmptyString(replyFrom.email) || !/^[^@\s]+@[^@\s]+$/.test(replyFrom.email)) {
    throw new Error('config: "mail.replyFrom.email" must be an email address');
  }
  if (!isNonEmptyString(replyFrom.name)) throw new Error('config: "mail.replyFrom.name" must be a non-empty string');

  const capacity = section(raw, 'capacity', 'capacity');
  if (!isPositiveInt(capacity.activitiesMaxItems)) {
    throw new Error('config: "capacity.activitiesMaxItems" must be a positive integer');
  }
  if (typeof capacity.warnPct !== 'number' || !Number.isInteger(capacity.warnPct) || capacity.warnPct < 1 || capacity.warnPct > 100) {
    throw new Error('config: "capacity.warnPct" must be an integer from 1 to 100');
  }

  const alerts = section(raw, 'alerts', 'alerts');
  if (!('itRequests' in alerts)) throw new Error('config: missing required key "alerts.itRequests" (null disables it)');
  const it = alerts.itRequests;
  if (it !== null) {
    if (!isObject(it)) throw new Error('config: "alerts.itRequests" must be an object, or null to disable');
    if (!isPositiveInt(it.boardId)) throw new Error('config: "alerts.itRequests.boardId" must be a Monday board id number');
    if (!isNonEmptyString(it.typeColumn)) throw new Error('config: "alerts.itRequests.typeColumn" must be a Monday column id');
    if (!isNonEmptyString(it.typeLabel)) throw new Error('config: "alerts.itRequests.typeLabel" must be a non-empty label');
    if (!isPositiveInt(it.cooldownDays)) throw new Error('config: "alerts.itRequests.cooldownDays" must be a positive integer');
  }

  return raw as unknown as EmailLogConfig;
}
