// Which email addresses the info door shows, and the label each one carries.
//
// The privacy rule (design "Email address labels", decided 2026-11-18), the same for a session of
// any size: a person's Personal Email shows only when the session was signed in with it; their
// Household Email shows when the session was signed in with it, or with that person's Personal
// Email. So one person signed in by Household Email sees only that address, and a household signed
// in by its shared Household Email sees it under each person, never anyone's Personal Email. A
// session that doesn't know its address (a letter-ready link, or one from before migration 0008)
// shows none.
import type { DonorEmails } from '../types';
import { sha256Hex } from '../crypto/hash';

export type EmailLabel = 'verified' | 'subscribed' | 'onFile' | 'bounced';

export interface ShownEmail {
  address: string;
  kind: 'personal' | 'household';
  label: EmailLabel;
}

// The hash sign-in stores on the session (POST / trims and lowercases before requestLogin hashes).
export function signInEmailHash(address: string): Promise<string> {
  return sha256Hex(address.trim().toLowerCase());
}

// Cleaned (Mailchimp's bounced) wins, so the member knows to correct it; then a completed sign-in;
// then the consent column; else the address is simply on file.
export function emailLabel(consent: string, verified: boolean): EmailLabel {
  const status = consent.trim().toLowerCase();
  if (status === 'cleaned') return 'bounced';
  if (verified) return 'verified';
  if (status === 'subscribed') return 'subscribed';
  return 'onFile';
}

// `people` is everyone the session covers, in order; a person whose read failed is passed with
// blank emails. `verified` holds `${emailHash}:${personId}` keys (VerifiedEmailStore.verifiedFor);
// `hash` is signInEmailHash.
export async function visibleEmails(
  people: { id: string; emails: DonorEmails }[],
  sessionEmailHash: string | null,
  verified: Set<string>,
  hash: (address: string) => Promise<string>
): Promise<Record<string, ShownEmail[]>> {
  const shown: Record<string, ShownEmail[]> = {};
  for (const person of people) {
    shown[person.id] = sessionEmailHash === null ? [] : await personEmails(person, sessionEmailHash, verified, hash);
  }
  return shown;
}

async function personEmails(
  person: { id: string; emails: DonorEmails },
  sessionEmailHash: string,
  verified: Set<string>,
  hash: (address: string) => Promise<string>
): Promise<ShownEmail[]> {
  const personal = person.emails.personal.trim();
  const household = person.emails.household.trim();
  const personalHash = personal === '' ? null : await hash(personal);
  const householdHash = household === '' ? null : await hash(household);
  const signedInByPersonal = personalHash === sessionEmailHash;

  const list: ShownEmail[] = [];
  const add = (address: string, addressHash: string, kind: ShownEmail['kind'], consent: string) =>
    list.push({ address, kind, label: emailLabel(consent, verified.has(`${addressHash}:${person.id}`)) });

  if (personalHash !== null && signedInByPersonal) add(personal, personalHash, 'personal', person.emails.personalConsent);
  // The same address in both columns shows once, as Personal.
  if (householdHash !== null && householdHash !== personalHash && (householdHash === sessionEmailHash || signedInByPersonal)) {
    add(household, householdHash, 'household', person.emails.householdConsent);
  }
  return list;
}
