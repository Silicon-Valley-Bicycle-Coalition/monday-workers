import type { Config, DonorRecord } from '../types';
import { stateFromZip } from './zipState';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// A Monday number column's text ("1250", "1250.5") as email copy: "$1,250", "$1,250.50". Whole
// dollars drop the cents. Blank or unreadable gives '', which clears the merge field.
export function formatGiftAmount(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const amount = Number(trimmed.replace(/[$,]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const formatted = USD.format(amount);
  return formatted.endsWith('.00') ? formatted.slice(0, -3) : formatted;
}

export function buildMergeFields(donor: DonorRecord, config: Config): Record<string, unknown> {
  const fields = config.mailchimp.mergeFields;
  const mergeFields: Record<string, unknown> = {
    [fields.memberSince]: donor.memberSince,
    [fields.memberUntil]: donor.memberUntil,
    [fields.membershipTier]: donor.membershipTier,
    [fields.membershipStatus]: donor.membershipStatus,
    [fields.totalGiven]: donor.totalGiven,
  };

  // Only when both ends are configured: an unconfigured column must not blank the merge field.
  if (fields.lastGiftAmount && donor.lastGiftAmount !== null) {
    mergeFields[fields.lastGiftAmount] = formatGiftAmount(donor.lastGiftAmount);
  }

  // Mailchimp rejects an incomplete ADDRESS merge field with an HTTP 400 (a permanent
  // error — see mailchimp/client.ts), which would otherwise ack-and-never-retry the whole
  // upsert, silently stopping this donor's sync forever (including the membership-date
  // fields above). Only send it once all four components are present; omitting a merge
  // field from the payload entirely leaves it at its current Mailchimp value rather than
  // clearing it, same as every other field here that isn't explicitly zeroed out.
  // A State column wins; without one (production People) the ZIP gives the state.
  const state = donor.state !== '' ? donor.state : stateFromZip(donor.zip);
  if (donor.addr1 !== '' && donor.city !== '' && state !== '' && donor.zip !== '') {
    mergeFields[fields.address] = {
      addr1: donor.addr1,
      city: donor.city,
      state,
      zip: donor.zip,
      country: 'US',
    };
  }

  return mergeFields;
}

export function buildTags(donor: DonorRecord, config: Config): string[] {
  const tags = config.mailchimp.tags;
  const out: string[] = [];

  if (donor.membershipTier === config.lifetimeTierValue) {
    out.push(tags.lifetimeMember);
  } else if (donor.membershipStatus === config.activeStatusValue) {
    out.push(tags.activeMember);
  } else if (donor.membershipStatus !== '') {
    out.push(tags.lapsedMember);
  }
  // A blank Membership Status is someone who has never been a member: no membership tag, so
  // syncTags deactivates any of the three a contact still carries.

  const total = Number(donor.totalGiven);
  if (!Number.isNaN(total) && total > 0) {
    out.push(tags.hasDonated);
  }

  // Tagged as soon as the box is checked, before anyone reviews the reason — fundraising sends
  // exclude this tag. Unchecking drops it (managedTags deactivates it). The unsubscribe itself
  // waits for review; see consumer/outbound.ts.
  if (donor.doNotSolicit) {
    out.push(tags.doNotSolicit);
  }

  // Renewal Journeys exclude this tag: an active recurring gift renews itself. Unchecking drops it.
  if (donor.hasActiveRecurringGift) {
    out.push(tags.recurringDonor);
  }

  for (const label of donor.nearby) out.push(config.mailchimp.nearbyTagPrefix + label);

  return out;
}

/**
 * The Customer Journey interests to turn on for a contact, from its tags before this sync
 * (`priorTags`) and the tags it is about to get (`desiredTags`). Only ever turns interests on;
 * a contact who unticks one keeps it off until the next transition below.
 *
 * - Welcome Drip: when the contact first becomes a member, i.e. it held none of the three
 *   membership tags and now gets active or lifetime. New members only: existing and returning
 *   members never get the welcome series.
 * - Renewal Reminders: whenever the contact gains active-member (new or returning), unless it
 *   carries the Renewal Opt Out tag. Lifetime members never expire, so they don't get it.
 */
export function journeyInterests(priorTags: readonly string[], desiredTags: readonly string[], config: Config): Record<string, boolean> {
  const journeys = config.mailchimp.journeyInterests;
  if (journeys === null) return {};
  const { activeMember, lapsedMember, lifetimeMember } = config.mailchimp.tags;
  const prior = new Set(priorTags);
  const wasMember = prior.has(activeMember) || prior.has(lapsedMember) || prior.has(lifetimeMember);
  const becomesActive = desiredTags.includes(activeMember) && !prior.has(activeMember);
  const becomesMember = !wasMember && (desiredTags.includes(activeMember) || desiredTags.includes(lifetimeMember));
  const out: Record<string, boolean> = {};
  if (journeys.welcomeDrip !== null && becomesMember) out[journeys.welcomeDrip] = true;
  if (journeys.renewalReminders !== null && becomesActive && !prior.has(journeys.renewalOptOutTag)) out[journeys.renewalReminders] = true;
  return out;
}

// Every Mailchimp tag this worker owns — the only tags updateMember is allowed to
// deactivate when buildTags no longer produces them. Must stay a superset of every
// possible buildTags output; anything outside this set is left alone in Mailchimp.
// Nearby tags are open-ended (one per label), so the member's current tags that start with the
// Nearby prefix are owned too: that is how a label removed on Monday is deactivated. The prefix
// is reserved for this worker; a staff-made tag with it would be cleared the same way.
export function managedTags(config: Config, currentMemberTags: string[] = []): string[] {
  const tags = config.mailchimp.tags;
  const prefix = config.mailchimp.nearbyTagPrefix;
  const nearby = currentMemberTags.filter((name) => name.startsWith(prefix));
  return [tags.activeMember, tags.lapsedMember, tags.lifetimeMember, tags.hasDonated, tags.doNotSolicit, tags.recurringDonor, ...nearby];
}
