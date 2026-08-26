import type { Config, DonorRecord } from '../types';

export function buildMergeFields(donor: DonorRecord, config: Config): Record<string, unknown> {
  const fields = config.mailchimp.mergeFields;
  return {
    [fields.memberSince]: donor.memberSince,
    [fields.memberUntil]: donor.memberUntil,
    [fields.membershipTier]: donor.membershipTier,
    [fields.membershipStatus]: donor.membershipStatus,
    [fields.address]: {
      addr1: donor.addr1,
      city: donor.city,
      state: donor.state,
      zip: donor.zip,
      country: 'US',
    },
    [fields.totalGiven]: donor.totalGiven,
  };
}

export function buildTags(donor: DonorRecord, config: Config): string[] {
  const tags = config.mailchimp.tags;
  const out: string[] = [];

  if (donor.membershipTier === config.lifetimeTierValue) {
    out.push(tags.lifetimeMember);
  } else if (donor.membershipStatus === config.activeStatusValue) {
    out.push(tags.activeMember);
  } else {
    out.push(tags.lapsedMember);
  }

  const total = Number(donor.totalGiven);
  if (!Number.isNaN(total) && total > 0) {
    out.push(tags.hasDonated);
  }

  return out;
}
