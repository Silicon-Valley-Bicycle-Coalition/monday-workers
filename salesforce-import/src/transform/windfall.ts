import { dateCol } from './fields.js';

// Windfall wealth screening (monday-migration docs/09, decided 2026-10-26). SVBC no longer
// subscribes, so these values are frozen as of Windfall's last sync. Nine fields become People
// columns; the rest that are kept fold into one long-text Windfall Profile. Political Party and
// the two political-donor flags are deliberately not extracted. `wf_last_updated__c` isn't
// extracted either: it's empty on every Contact.

// Text fields for the profile, in display order. `[label, field]`; Company Address is assembled
// from the five COMPANY_ADDRESS fields and lands after Company Phone.
const PROFILE_TEXT: [string, string][] = [
  ['Job Level', 'wf_job_title_level__c'],
  ['Job Function', 'wf_job_functions__c'],
  ['Job Start', 'wf_job_start_date__c'],
  ['Company Category', 'wf_company_type__c'],
  ['Company Size', 'wf_company_employees_range__c'],
  ['Company Revenue', 'wf_company_revenue_range__c'],
  ['Company NAICS', 'wf_company_naics_code__c'],
  ['Company Domain', 'wf_company_domain__c'],
  ['Company Phone', 'wf_company_phone__c'],
  ['Employment Match Confidence', 'wf_employment_match_confidence__c'],
  ['Employment Data Updated', 'wf_employment_data_last_updated__c'],
  ['Net Worth Match Confidence', 'wf_match_confidence__c'],
  ['NTEE Codes', 'wf_ntee_codes__c'],
  ['Regional Focus', 'wf_regional_focus__c'],
];
const COMPANY_ADDRESS = ['wf_company_address_line_one__c', 'wf_company_address_line_two__c',
  'wf_company_city__c', 'wf_company_state_code__c', 'wf_company_zipcode__c'];

// Checkbox fields, listed by label on one "Flags" line when true. `[label, field]`.
const PROFILE_FLAGS: [string, string][] = [
  ['Trust Association', 'wf_trust__c'],
  ['Foundation Association', 'wf_foundation_association__c'],
  ['Foundation Officer/Trustee', 'wf_foundation_officer__c'],
  ['Nonprofit Board Member', 'wf_nonprofit_board_member__c'],
  ['Multi-property Owner', 'wf_multi_property_owner__c'],
  ['Small Business Owner', 'wf_small_business_owner__c'],
  ['Imported Car Owner', 'wf_imported_car_owner__c'],
  ['Luxury Car Owner', 'wf_luxury_car_owner__c'],
  ['Plane Owner', 'wf_plane_owner__c'],
  ['Boat Owner', 'wf_boat_owner__c'],
  ['Windfall Trigger', 'wf_recent_liquidity__c'],
  ['Money in Motion', 'wf_money_in_motion__c'],
  ['Recent Mortgage', 'wf_recent_mortgage__c'],
  ['Recent Mover', 'wf_recent_mover__c'],
  ['Recently Changed Jobs', 'wf_recently_changed_job__c'],
  ['Recently Changed Jobs Since Last Update', 'wf_has_changed_job_recently__c'],
  ['Recently Changed Companies', 'wf_has_changed_company_recently__c'],
  ['Recently Promoted', 'wf_is_promoted_recently__c'],
  ['Recently Retired', 'wf_is_retired_recently__c'],
  ['Recently Divorced', 'wf_recent_divorce__c'],
  ['Recent Death in Family', 'wf_recent_death__c'],
  ['Primary Address Incorrect', 'wf_primary_address_incorrect__c'],
];

// Every Contact field the transform reads — extract/queries.ts appends these to the Contact query.
export const WINDFALL_FIELDS: string[] = [
  'wf_windfall_id__c', 'Windfall_Priority__c',
  'wf_net_worth__c', 'wf_low_confidence_net_worth__c', 'wf_high_confidence_net_worth__c',
  'wf_net_worth_calculation_date__c', 'wf_philanthropic_giver__c',
  'wf_job_title__c', 'wf_company_name__c', 'wf_linkedin_url__c',
  ...PROFILE_TEXT.map(([, f]) => f), ...COMPANY_ADDRESS, ...PROFILE_FLAGS.map(([, f]) => f),
];

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/**
 * People columns for a Contact's Windfall data, or {} when Windfall never matched them (no
 * Windfall ID). Every key is written only when it has a value, so a person with no Windfall
 * data carries no Windfall columns at all.
 */
export function windfallColumns(c: Record<string, unknown>): Record<string, unknown> {
  const id = text(c['wf_windfall_id__c']);
  if (!id) return {};
  const columns: Record<string, unknown> = {
    'Windfall ID': id,
    'Net Worth': num(c['wf_net_worth__c']),
    // Windfall's "high/low confidence" net worths are the upper and lower bounds of its estimate
    // (high-confidence is the larger number), not two confidence scores.
    'Net Worth Low': num(c['wf_low_confidence_net_worth__c']),
    'Net Worth High': num(c['wf_high_confidence_net_worth__c']),
    'Net Worth Date': dateCol(c['wf_net_worth_calculation_date__c'] as string | null),
    'Philanthropic Giver': c['wf_philanthropic_giver__c'] ? { checked: 'true' } : null,
    'Job Title': text(c['wf_job_title__c']),
    'Windfall Company': text(c['wf_company_name__c']),
    'LinkedIn': text(c['wf_linkedin_url__c']),
    // A formula, snapshotted: 1 + 50 when net worth tops $10M + Opportunities closed last year.
    // Its giving term freezes at load; People's own rollups stay current.
    'Windfall Priority': num(c['Windfall_Priority__c']),
  };
  const profile = windfallProfile(c);
  if (profile) columns['Windfall Profile'] = { text: profile };
  return Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== '' && v !== null));
}

export function windfallProfile(c: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [label, f] of PROFILE_TEXT) {
    const v = text(c[f]);
    if (v) lines.push(`${label}: ${v}`);
    if (f === 'wf_company_phone__c') {
      const address = COMPANY_ADDRESS.map((a) => text(c[a])).filter(Boolean).join(', ');
      if (address) lines.push(`Company Address: ${address}`);
    }
  }
  const flags = PROFILE_FLAGS.filter(([, f]) => c[f] === true).map(([label]) => label);
  if (flags.length > 0) lines.push(`Flags: ${flags.join(', ')}`);
  return lines.join('\n');
}
