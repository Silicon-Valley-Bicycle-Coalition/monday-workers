import type { Config } from '../config.js';

export function dateCol(iso: string | null | undefined): unknown {
  if (!iso) return null;
  return { date: iso.slice(0, 10) };
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

export function salesforceDebug(row: Record<string, unknown>): Record<string, unknown> {
  const by = (v: unknown) => {
    const name = (v as { Name?: string } | null)?.Name ?? '';
    if (!name) return '';
    const email = staffMatch?.(name);
    return email ? `${name} (${email})` : name;
  };
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

export function consentColumns(email: string | null, consent: Map<string, string>): Record<string, unknown> {
  const status = email ? consent.get(email) : undefined;
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Not in Mailchimp';
  return { 'Email Consent': { label } };
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
