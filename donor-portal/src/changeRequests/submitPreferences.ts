import type { PrefField } from '../types';
import { submitChangeRequest, PREF_VALUES, type SubmitDeps } from './submitChangeRequest';

// Render/diff order for the preference fields — matches PREF_FIELD_COLUMNS in config.ts.
export const PREF_FIELD_ORDER: PrefField[] = ['emailOptOut', 'smsOptOut', 'doNotMail'];

export interface PreferencesInput {
  donorItemId: string;
  // Desired state per preference: true = opted out / do not mail. Fields absent from the map
  // (e.g. not configured, so not rendered on the form) are left untouched.
  prefs: Partial<Record<PrefField, boolean>>;
}

export type PreferencesResult =
  | { kind: 'submitted'; submitted: number; duplicates: number }
  | { kind: 'noChanges' }
  | { kind: 'invalid'; message: string };

// Diffs the submitted preference states against the donor's current Monday state and files one
// change request per actual change, through the same staff-review path as the free-text fields.
// Unchanged preferences produce nothing — staff only ever see real changes.
export async function submitPreferences(
  sessionDonorIds: string[],
  input: PreferencesInput,
  deps: SubmitDeps
): Promise<PreferencesResult> {
  if (!sessionDonorIds.includes(input.donorItemId)) {
    return { kind: 'invalid', message: 'Unknown donor record.' };
  }

  const contact = await deps.monday.getDonorContactInfo(input.donorItemId);
  const changes: { field: PrefField; newValue: string }[] = [];
  for (const field of PREF_FIELD_ORDER) {
    const desired = input.prefs[field];
    if (desired === undefined) continue;
    const current = contact[field];
    if (current === null) {
      return { kind: 'invalid', message: 'This preference is not available yet.' };
    }
    if (desired !== current) {
      changes.push({ field, newValue: desired ? PREF_VALUES[field].on : PREF_VALUES[field].off });
    }
  }
  if (changes.length === 0) {
    return { kind: 'noChanges' };
  }

  let submitted = 0;
  let duplicates = 0;
  for (const change of changes) {
    const result = await submitChangeRequest(
      sessionDonorIds,
      { donorItemId: input.donorItemId, field: change.field, newValue: change.newValue },
      deps
    );
    if (result.kind === 'submitted') submitted += 1;
    else if (result.kind === 'duplicate') duplicates += 1;
    else return result;
  }
  return { kind: 'submitted', submitted, duplicates };
}
