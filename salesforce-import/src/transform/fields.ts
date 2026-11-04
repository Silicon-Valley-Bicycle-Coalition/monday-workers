import type { Config } from '../config.js';

export function dateCol(iso: string | null | undefined): unknown {
  if (!iso) return null;
  return { date: iso.slice(0, 10) };
}

// en-CA formats as YYYY-MM-DD. The org and every event run on Pacific time (monday-migration docs/07 §7).
const pacificDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

// For a true datetime field, which the API returns in UTC: dateCol's slice puts anything after
// 4 or 5 pm Pacific on the next day. Same day eventbrite-sync writes (src/util/isoDate.ts).
export function pacificDate(iso: string | null | undefined): string {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? '' : pacificDay.format(ms);
}

export function pacificDateCol(iso: string | null | undefined): unknown {
  const date = pacificDate(iso);
  return date ? { date } : null;
}

// SVBC's fiscal year runs July→June (Organization.FiscalYearStartMonth = 7), so a gift closes
// into the fiscal year ending the following June once its month is July or later. Integer
// parsing, not Date-object arithmetic: it takes a plain date such as CloseDate and converts no
// timezone, so a datetime has to be reduced to its Pacific day first (see cnpGiftDay).
export function fiscalYear(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m) return '';
  return String(m >= 7 ? y + 1 : y);
}

// One consolidated long-text column instead of five separate provenance columns —
// never updated after the migration, and slated for a single-column delete once
// staff no longer need it. Names stay verbatim text (many are former employees
// with no Monday account to map to).
// Set once by runTransform when data/enrich/monday-users.csv is present; maps a
// Salesforce user name to a current staff member's Monday email, or null.
let staffMatch: ((sfName: string) => string | null) | null = null;
export function setStaffMatcher(matcher: ((sfName: string) => string | null) | null): void {
  staffMatch = matcher;
}
// Exact-name only (staff.ts exactStaffMatcher); feeds the Relationship Owner people column.
let ownerMatch: ((sfName: string) => string | null) | null = null;
export function setOwnerMatcher(matcher: ((sfName: string) => string | null) | null): void {
  ownerMatch = matcher;
}

// The current staff member's Monday email for a Salesforce owner, or '' — former staff and
// integration users leave Relationship Owner empty. Load swaps the email for a Monday user id.
export function relationshipOwner(v: unknown): string {
  const name = (v as { Name?: string } | null)?.Name ?? '';
  return (name && ownerMatch?.(name)) || '';
}

// "Name (email)" when the Salesforce user matches a current Monday staff member,
// bare "Name" otherwise — covers former staff *and* non-human accounts (integration
// users, guest logins) the same way, since neither matches a current staff export.
// See monday-migration docs/07 gotcha #3 / docs/05 §9: 25 "active" Salesforce users
// includes 14 that aren't real staff, which is exactly what this degrades gracefully
// for by matching against Monday's current user list instead of Salesforce's
// IsActive flag.
export function ownerAttribution(v: unknown): string {
  const name = (v as { Name?: string } | null)?.Name ?? '';
  if (!name) return '';
  const email = staffMatch?.(name);
  return email ? `${name} (${email})` : name;
}

export function salesforceDebug(row: Record<string, unknown>): Record<string, unknown> {
  const by = ownerAttribution;
  const day = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : '');
  const stamp = (label: string, date: string, name: string) =>
    date ? `${label}: ${date}${name ? ` by ${name}` : ''}` : '';
  const parts = [
    row['Id'] ? `SF ID: ${row['Id']}` : '',
    stamp('Created', day(row['CreatedDate']), by(row['CreatedBy'])),
    stamp('Modified', day(row['LastModifiedDate']), by(row['LastModifiedBy'])),
  ].filter(Boolean);
  return { 'Salesforce Debug': { text: parts.join(' | ') } };
}

const PREFERRED_FIELD: Record<string, string> = {
  personal: 'npe01__HomeEmail__c', home: 'npe01__HomeEmail__c',
  work: 'npe01__WorkEmail__c', alternate: 'npe01__AlternateEmail__c', email: 'Email',
};

export function collapseEmail(c: Record<string, unknown>): string | null {
  const val = (f: string) => {
    const v = c[f];
    return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
  };
  const pref = (c['npe01__Preferred_Email__c'] as string | null)?.trim().toLowerCase();
  const prefField = pref ? PREFERRED_FIELD[pref] : undefined;
  return (prefField && val(prefField)) || val('Primary_Email__c') || val('Email');
}

export function consentLabel(email: string | null, consent: ReadonlyMap<string, string>): string {
  const status = email ? consent.get(email) : undefined;
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Not in Mailchimp';
}

// Mailchimp subscription state belongs to an email address, not a person, so each email column
// on People gets its own consent status. Personal Email Consent is never blank ("Not in
// Mailchimp" also covers "no email at all") so the "who's missing from Mailchimp" filter stays
// reliable; Household Email Consent is left blank when there is no household address.
export function consentColumns(
  personal: string | null, household: string | null, consent: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const columns: Record<string, unknown> = { 'Personal Email Consent': { label: consentLabel(personal, consent) } };
  if (household) columns['Household Email Consent'] = { label: consentLabel(household, consent) };
  return columns;
}

export function localNewsUrl(city: string | null, cfg: Config['localNews']): string {
  const c = (city ?? '').trim().toLowerCase();
  for (const rule of cfg.rules) if (rule.cities.includes(c)) return rule.url;
  return cfg.defaultUrl;
}

export function localNewsName(city: string | null, cfg: Config['localNews']): string {
  const c = (city ?? '').trim().toLowerCase();
  for (const rule of cfg.rules) if (rule.cities.includes(c)) return rule.name;
  return cfg.defaultName;
}

// Funraise's platform URLs are global (no org slug); recurring subscriptions
// surface as recurring *transactions* in Funraise's UI, so Recurring Gifts use
// the transaction link too (confirmed with SVBC 2026-08-23).
const FUNRAISE_TRANSACTION_URL = 'https://platform.funraise.io/transaction/';
const FUNRAISE_SUPPORTER_URL = 'https://platform.funraise.io/supporter/';

const funraiseLink = (base: string, id: unknown) => {
  const text = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  return text ? { url: `${base}${text}`, text } : null;
};

export const funraiseTransactionLink = (id: unknown) => funraiseLink(FUNRAISE_TRANSACTION_URL, id);
export const funraiseSupporterLink = (id: unknown) => funraiseLink(FUNRAISE_SUPPORTER_URL, id);
