import type { Config } from '../config.js';

export function dateCol(iso: string | null | undefined): unknown {
  if (!iso) return null;
  return { date: iso.slice(0, 10) };
}

export function provenanceColumns(row: Record<string, unknown>): Record<string, unknown> {
  const by = (v: unknown) => (v as { Name?: string } | null)?.Name ?? '';
  return {
    'Salesforce Created Date': dateCol(row['CreatedDate'] as string),
    'Salesforce Created By': by(row['CreatedBy']),
    'Salesforce Modified Date': dateCol(row['LastModifiedDate'] as string),
    'Salesforce Modified By': by(row['LastModifiedBy']),
  };
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
