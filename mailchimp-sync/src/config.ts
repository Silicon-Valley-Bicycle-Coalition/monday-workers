import type { Config, MondayColumnsConfig, MailchimpMergeFieldsConfig, MailchimpTagsConfig } from './types';

const REQUIRED_TOP_LEVEL = ['monday', 'mailchimp', 'lifetimeTierValue', 'activeStatusValue', 'dnsConfirmedValue'] as const;

const REQUIRED_MONDAY_COLUMNS: (keyof MondayColumnsConfig)[] = [
  'membershipStatus', 'membershipTier', 'memberSince', 'memberUntil',
  'addr1', 'city', 'state', 'zip', 'email', 'totalGiven', 'mailchimpCampaigns',
  'doNotSolicit', 'dnsReasonStatus',
];

const REQUIRED_MERGE_FIELDS: (keyof MailchimpMergeFieldsConfig)[] = [
  'memberSince', 'memberUntil', 'membershipTier', 'membershipStatus', 'address', 'totalGiven',
];

const REQUIRED_TAGS: (keyof MailchimpTagsConfig)[] = [
  'activeMember', 'lapsedMember', 'lifetimeMember', 'hasDonated', 'doNotSolicit',
];

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${path}"`);
  }
  return value as Record<string, unknown>;
}

function requireStringKeys(obj: Record<string, unknown>, keys: readonly string[], prefix: string): void {
  for (const key of keys) {
    if (typeof obj[key] !== 'string' || obj[key] === '') {
      throw new Error(`config: missing required key "${prefix}.${key}"`);
    }
  }
}

function numberOrNull(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') {
    throw new Error(`config: "${path}" must be a number or null`);
  }
  return value;
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: expected an object');
  }
  const cfg = raw as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in cfg)) {
      throw new Error(`config: missing required key "${key}"`);
    }
  }

  const monday = requireObject(cfg.monday, 'monday');
  if (typeof monday.apiUrl !== 'string' || monday.apiUrl === '') {
    throw new Error('config: missing required key "monday.apiUrl"');
  }
  const columns = requireObject(monday.columns, 'monday.columns');
  requireStringKeys(columns, REQUIRED_MONDAY_COLUMNS, 'monday.columns');
  // Explicit null (not an absent key) says "this deployment has no Nearby column yet".
  if (columns.nearby !== null && (typeof columns.nearby !== 'string' || columns.nearby === '')) {
    throw new Error('config: "monday.columns.nearby" must be a column id or null');
  }

  const mailchimp = requireObject(cfg.mailchimp, 'mailchimp');
  if (typeof mailchimp.apiBaseUrl !== 'string' || mailchimp.apiBaseUrl === '') {
    throw new Error('config: missing required key "mailchimp.apiBaseUrl"');
  }
  if (typeof mailchimp.audienceId !== 'string' || mailchimp.audienceId === '') {
    throw new Error('config: missing required key "mailchimp.audienceId"');
  }
  const mergeFields = requireObject(mailchimp.mergeFields, 'mailchimp.mergeFields');
  requireStringKeys(mergeFields, REQUIRED_MERGE_FIELDS, 'mailchimp.mergeFields');
  const tags = requireObject(mailchimp.tags, 'mailchimp.tags');
  requireStringKeys(tags, REQUIRED_TAGS, 'mailchimp.tags');
  if (typeof mailchimp.nearbyTagPrefix !== 'string' || mailchimp.nearbyTagPrefix === '') {
    throw new Error('config: missing required key "mailchimp.nearbyTagPrefix"');
  }
  const categoryIds = mailchimp.interestCategoryIds;
  if (!Array.isArray(categoryIds) || categoryIds.length === 0
    || !categoryIds.every((id) => typeof id === 'string' && id !== '')) {
    throw new Error('config: "mailchimp.interestCategoryIds" must be a non-empty array of category ids');
  }

  if (typeof cfg.lifetimeTierValue !== 'string' || cfg.lifetimeTierValue === '') {
    throw new Error('config: missing required key "lifetimeTierValue"');
  }
  if (typeof cfg.activeStatusValue !== 'string' || cfg.activeStatusValue === '') {
    throw new Error('config: missing required key "activeStatusValue"');
  }
  if (typeof cfg.dnsConfirmedValue !== 'string' || cfg.dnsConfirmedValue === '') {
    throw new Error('config: missing required key "dnsConfirmedValue"');
  }

  return {
    monday: {
      apiUrl: monday.apiUrl,
      donorsBoardId: numberOrNull(monday.donorsBoardId, 'monday.donorsBoardId'),
      campaignsBoardId: numberOrNull(monday.campaignsBoardId, 'monday.campaignsBoardId'),
      columns: columns as unknown as MondayColumnsConfig,
    },
    mailchimp: {
      apiBaseUrl: mailchimp.apiBaseUrl,
      audienceId: mailchimp.audienceId,
      mergeFields: mergeFields as unknown as MailchimpMergeFieldsConfig,
      tags: tags as unknown as MailchimpTagsConfig,
      nearbyTagPrefix: mailchimp.nearbyTagPrefix,
      interestCategoryIds: categoryIds as string[],
    },
    lifetimeTierValue: cfg.lifetimeTierValue,
    activeStatusValue: cfg.activeStatusValue,
    dnsConfirmedValue: cfg.dnsConfirmedValue,
  };
}
