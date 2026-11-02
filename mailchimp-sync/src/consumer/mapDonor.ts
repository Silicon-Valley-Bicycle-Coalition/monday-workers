import type { Config, DonorRecord } from '../types';

export function buildMergeFields(donor: DonorRecord, config: Config): Record<string, unknown> {
  const fields = config.mailchimp.mergeFields;
  const mergeFields: Record<string, unknown> = {
    [fields.memberSince]: donor.memberSince,
    [fields.memberUntil]: donor.memberUntil,
    [fields.membershipTier]: donor.membershipTier,
    [fields.membershipStatus]: donor.membershipStatus,
    [fields.totalGiven]: donor.totalGiven,
  };

  // Mailchimp rejects an incomplete ADDRESS merge field with an HTTP 400 (a permanent
  // error — see mailchimp/client.ts), which would otherwise ack-and-never-retry the whole
  // upsert, silently stopping this donor's sync forever (including the membership-date
  // fields above). Only send it once all four components are present; omitting a merge
  // field from the payload entirely leaves it at its current Mailchimp value rather than
  // clearing it, same as every other field here that isn't explicitly zeroed out.
  if (donor.addr1 !== '' && donor.city !== '' && donor.state !== '' && donor.zip !== '') {
    mergeFields[fields.address] = {
      addr1: donor.addr1,
      city: donor.city,
      state: donor.state,
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

  return out;
}

// Every Mailchimp tag this worker owns — the only tags updateMember is allowed to
// deactivate when buildTags no longer produces them. Must stay a superset of every
// possible buildTags output; anything outside this set is left alone in Mailchimp.
export function managedTags(config: Config): string[] {
  const tags = config.mailchimp.tags;
  return [tags.activeMember, tags.lapsedMember, tags.lifetimeMember, tags.hasDonated, tags.doNotSolicit];
}
