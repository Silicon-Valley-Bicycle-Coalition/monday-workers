import type { PrefField } from '../types';
import { submitChangeRequest, PREF_VALUES, type SubmitDeps } from './submitChangeRequest';
import { sha256Hex } from '../crypto/hash';
import type { ChangeRequestStore } from '../db/changeRequests';

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

export function preferenceWindowStart(now: Date, dedupeWindowHours: number): string {
  return new Date(now.getTime() - dedupeWindowHours * 3600 * 1000).toISOString();
}

// The member's newest request for a preference inside the window (true = opted out), or null for
// none. Also what the Profile tab shows (src/doors/info.ts): Monday and Mailchimp catch up after
// the writer applies it, and the email side only on mailchimp-sync's hourly consent run.
export async function pendingPreference(
  store: Pick<ChangeRequestStore, 'findRecentByDedupeHash'>,
  donorItemId: string,
  field: PrefField,
  sinceISO: string
): Promise<boolean | null> {
  const find = async (value: string) => store.findRecentByDedupeHash(await sha256Hex(`${donorItemId}|${field}|${value}`), sinceISO);
  const [on, off] = await Promise.all([find(PREF_VALUES[field].on), find(PREF_VALUES[field].off)]);
  if (on === null && off === null) return null;
  if (off === null) return true;
  if (on === null) return false;
  return on.id > off.id;
}

// Diffs the submitted preference states against the donor's effective state and files one change
// request per actual change, through the same Change Requests path as the free-text fields.
// Unchanged preferences produce nothing — staff only ever see real changes.
//
// The effective state is the member's latest request still inside the dedupe window, else Monday.
// Requests are applied in order, so a preference saved live and switched back before the first
// was applied must be filed again ("Opted out → Subscribed"), not read as "matches Monday": that
// would leave the opt-out pending. Likewise a third switch must file even though an identical
// first request is still in the window (supersedes skips the dedupe).
export async function submitPreferences(
  sessionDonorIds: string[],
  input: PreferencesInput,
  deps: SubmitDeps
): Promise<PreferencesResult> {
  if (!sessionDonorIds.includes(input.donorItemId)) {
    return { kind: 'invalid', message: 'Unknown donor record.' };
  }

  const contact = await deps.monday.getDonorContactInfo(input.donorItemId);
  const sinceISO = preferenceWindowStart(deps.now(), deps.dedupeWindowHours);
  const latestPending = (field: PrefField) => pendingPreference(deps.store, input.donorItemId, field, sinceISO);
  const changes: { field: PrefField; newValue: string; supersedes?: { oldValue: string } }[] = [];
  for (const field of PREF_FIELD_ORDER) {
    const desired = input.prefs[field];
    if (desired === undefined) continue;
    const current = contact[field];
    if (current === null) {
      return { kind: 'invalid', message: 'This preference is not available yet.' };
    }
    const pending = await latestPending(field);
    const effective = pending ?? current;
    if (desired !== effective) {
      const newValue = desired ? PREF_VALUES[field].on : PREF_VALUES[field].off;
      // Filed over a pending request: record what it overrides and skip the dedupe.
      const supersedes = pending === null ? undefined : { oldValue: pending ? PREF_VALUES[field].on : PREF_VALUES[field].off };
      changes.push({ field, newValue, ...(supersedes === undefined ? {} : { supersedes }) });
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
      { donorItemId: input.donorItemId, ...change },
      deps
    );
    if (result.kind === 'submitted') submitted += 1;
    else if (result.kind === 'duplicate') duplicates += 1;
    else return result;
  }
  return { kind: 'submitted', submitted, duplicates };
}
