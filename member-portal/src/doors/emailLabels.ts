// Which email addresses the info door shows, and the label each one carries.
//
// The privacy rule (design "Email address labels", refined by the plan): a session covering one
// person shows that person's Personal and Household Email. A session covering several people shows
// only the address it was signed in with, under each person whose record holds it, and never
// another person's other addresses. A household session that doesn't know its address (a
// letter-ready link, or a session from before migration 0008) shows none.
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
// blank emails so the household is still counted as one. `verified` holds
// `${emailHash}:${personId}` keys (VerifiedEmailStore.verifiedFor); `hash` is signInEmailHash.
export async function visibleEmails(
  people: { id: string; emails: DonorEmails }[],
  sessionEmailHash: string | null,
  verified: Set<string>,
  hash: (address: string) => Promise<string>
): Promise<Record<string, ShownEmail[]>> {
  const household = people.length > 1;
  const shown: Record<string, ShownEmail[]> = {};
  for (const person of people) {
    const candidates = [
      { address: person.emails.personal.trim(), kind: 'personal' as const, consent: person.emails.personalConsent },
      { address: person.emails.household.trim(), kind: 'household' as const, consent: person.emails.householdConsent },
    ];
    const list: ShownEmail[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.address === '') continue;
      const addressHash = await hash(candidate.address);
      // The same address in both columns shows once, as Personal.
      if (seen.has(addressHash)) continue;
      seen.add(addressHash);
      if (household && (sessionEmailHash === null || addressHash !== sessionEmailHash)) continue;
      list.push({
        address: candidate.address,
        kind: candidate.kind,
        label: emailLabel(candidate.consent, verified.has(`${addressHash}:${person.id}`)),
      });
    }
    shown[person.id] = list;
  }
  return shown;
}
