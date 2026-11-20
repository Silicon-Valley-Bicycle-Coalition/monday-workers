import type { ChangeRequestRow, ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { Config, PrefField } from '../types';
import { PREF_FIELD_COLUMNS } from '../config';
import { FIELD_LABELS, PREF_VALUES } from './submitChangeRequest';

// mailchimp-sync's PreferenceSync entrypoint (service binding MAILCHIMP_PREFS on the writer).
// Returns what it did, for the Change Requests log item: unsubscribed, pending (Mailchimp emailed a
// confirm link), already-unsubscribed, already-subscribed, already-pending, cleaned, not-in-audience.
export interface EmailPreferenceSink {
  setEmailPreference(email: string, optedOut: boolean, requestId: string): Promise<string>;
}

export interface ApplyPreferenceDeps {
  monday: MondayClient;
  store: ChangeRequestStore;
  config: Config;
  emailPreferences?: EmailPreferenceSink;
}

// A member's communication preference, applied by the writer with no staff step (portal live save,
// 2026-11-19): email goes to Mailchimp, the consent system of record (mailchimp-sync's hourly
// consent cron carries it back to Personal Email Consent); SMS Opt-Out and Do Not Mail are
// People-board checkboxes, so staff texting through Zoom or mailing see them on the person.
// Returns what the Change Requests log item should say. A request a newer one for the same field
// supersedes is logged but not applied, so queue order can't let an older choice land last.
// Every write is idempotent (a set, not a toggle), so a retry after a partial run is safe.
export async function applyPreference(row: ChangeRequestRow, deps: ApplyPreferenceDeps): Promise<{ fieldLabel: string; newValue: string }> {
  const field = row.field as PrefField;
  const label = FIELD_LABELS[field];
  if (await deps.store.hasNewerRequest(row)) return { fieldLabel: `${label} (superseded)`, newValue: row.newValue };
  const optedOut = row.newValue === PREF_VALUES[field].on;

  if (field === 'emailOptOut') {
    if (deps.emailPreferences === undefined) throw new Error('config: MAILCHIMP_PREFS binding is not set');
    // Personal Email only: a Household Email may be shared (mailchimp-sync's Do Not Solicit rule).
    const personal = (await deps.monday.getDonorEmails(row.donorItemId)).personal.trim();
    if (personal === '') return { fieldLabel: `${label} (no Personal Email)`, newValue: row.newValue };
    const result = await deps.emailPreferences.setEmailPreference(personal, optedOut, String(row.id));
    return { fieldLabel: `${label} (Mailchimp: ${result})`, newValue: row.newValue };
  }

  const columnId = deps.config.monday.columns[PREF_FIELD_COLUMNS[field]];
  if (typeof columnId !== 'string' || columnId === 'REPLACE_WITH_COLUMN_ID') {
    throw new Error(`config: monday.columns.${PREF_FIELD_COLUMNS[field]} is not configured`);
  }
  await deps.monday.setDonorCheckbox({ itemId: row.donorItemId, columnId, checked: optedOut });
  return { fieldLabel: `${label} (applied)`, newValue: row.newValue };
}
