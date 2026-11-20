// A member's own email preference, set from the member portal (its writer calls the
// PreferenceSync entrypoint in index.ts through a service binding, once per change request).
// Mailchimp is the consent system of record, so the portal changes it here, and this Worker's
// hourly consent cron carries the result back to the People board's Personal Email Consent.
//
// Opting out unsubscribes the address; opting back in sets it to pending, so Mailchimp emails a
// confirm link and only the member's click subscribes them. The address is the person's Personal
// Email only (the Household Email may be shared — same rule as Do Not Solicit).
import type { MailchimpClient, ResubscribeResult, UnsubscribeResult } from '../mailchimp/client';
import type { WriteMode } from '../flags';

export type EmailPreferenceResult = UnsubscribeResult | ResubscribeResult;

export class WritesHeldError extends Error {
  constructor(mode: WriteMode) {
    super(`mailchimp-sync writes are ${mode}; retry later`);
    this.name = 'WritesHeldError';
  }
}

// `mailchimp` is the live client under `on` and the dry-run one under `off`; under `hold` or
// `unknown` nothing is read or written and the caller's queue retries.
export async function setEmailPreference(
  email: string,
  optedOut: boolean,
  deps: { mode: WriteMode; mailchimp: MailchimpClient },
): Promise<EmailPreferenceResult> {
  if (deps.mode === 'hold' || deps.mode === 'unknown') throw new WritesHeldError(deps.mode);
  if (email.trim() === '') throw new Error('setEmailPreference: no address');
  return optedOut ? deps.mailchimp.unsubscribeMember(email) : deps.mailchimp.requestResubscribe(email);
}
