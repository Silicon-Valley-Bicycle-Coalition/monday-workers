import type { ChangeRequestField } from '../db/changeRequests';
import type { DonorContactInfo } from '../types';
import { MAX_NEW_VALUE_LENGTH, submitChangeRequest, type SubmitDeps } from './submitChangeRequest';

// The contact form's fields, in form order, with the DonorContactInfo property each is diffed
// against. Employer only while employerAnswerEnabled (deps.employerEnabled).
export const CONTACT_FIELDS: { field: ChangeRequestField; current: keyof DonorContactInfo }[] = [
  { field: 'address', current: 'address' },
  { field: 'email', current: 'email' },
  { field: 'phone', current: 'phone' },
  { field: 'language', current: 'preferredLanguage' },
  { field: 'employer', current: 'employer' },
];

export interface ContactChangesInput {
  donorItemId: string;
  // The submitted value per field; a field absent from the form is absent here.
  values: Partial<Record<ChangeRequestField, string>>;
  // The email the form was prefilled with ('' when it showed none). Email is diffed against this,
  // never against Monday: the form leaves a household member's address out (src/doors/info.ts),
  // and diffing a typed guess against the real one would answer "no changes" on a match.
  emailWas?: string;
}

export type ContactChangesResult =
  | { kind: 'submitted'; submitted: number; duplicates: number }
  | { kind: 'noChanges' }
  | { kind: 'invalid'; message: string };

// The whole-form counterpart of submitChangeRequest: diffs every submitted field against the
// donor's current Monday values and files one change request per field that differs, through the
// same staff-review path. A field left blank is no change (a change request can't clear a value).
// The other fields are already on the Profile tab for everyone in the session, so diffing them
// against Monday reveals nothing; email is diffed against emailWas instead.
export async function submitContactChanges(
  sessionDonorIds: string[],
  input: ContactChangesInput,
  deps: SubmitDeps
): Promise<ContactChangesResult> {
  if (!sessionDonorIds.includes(input.donorItemId)) {
    return { kind: 'invalid', message: 'Unknown donor record.' };
  }
  for (const value of Object.values(input.values)) {
    if (value !== undefined && value.trim().length > MAX_NEW_VALUE_LENGTH) {
      return { kind: 'invalid', message: `Please enter a value up to ${MAX_NEW_VALUE_LENGTH} characters.` };
    }
  }

  const contact = await deps.monday.getDonorContactInfo(input.donorItemId);
  const changes: { field: ChangeRequestField; newValue: string }[] = [];
  for (const { field, current } of CONTACT_FIELDS) {
    if (field === 'employer' && deps.employerEnabled !== true) continue;
    const desired = input.values[field]?.trim() ?? '';
    if (desired === '') continue;
    const was = field === 'email' ? (input.emailWas ?? '') : String(contact[current] ?? '');
    if (desired !== was.trim()) changes.push({ field, newValue: desired });
  }
  if (changes.length === 0) return { kind: 'noChanges' };

  let submitted = 0;
  let duplicates = 0;
  for (const change of changes) {
    const result = await submitChangeRequest(sessionDonorIds, { donorItemId: input.donorItemId, ...change }, deps);
    if (result.kind === 'submitted') submitted += 1;
    else if (result.kind === 'duplicate') duplicates += 1;
    else return result;
  }
  return { kind: 'submitted', submitted, duplicates };
}
