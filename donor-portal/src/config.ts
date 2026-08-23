import type { Config, MondayColumns } from './types';

const REQUIRED_TOP_LEVEL = ['monday', 'resend', 'auth', 'rateLimit'] as const;

const REQUIRED_COLUMNS: (keyof MondayColumns)[] = [
  'donorEmail',
  'membershipStatus',
  'membershipTier',
  'dollarDonated',
  'donationDonorLink',
  'donationAmount',
  'donationDate',
  'donationDescription',
  'discountOffered',
  'discountActive',
];

const REQUIRED_RESEND_KEYS = ['fromAddress', 'fromName'] as const;
const REQUIRED_AUTH_KEYS = ['magicLinkTtlMinutes', 'sessionTtlHours', 'portalBaseUrl'] as const;
const REQUIRED_RATE_LIMIT_KEYS = ['emailWindowSeconds', 'emailMaxAttempts'] as const;

function requireObject(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = cfg[key];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`config: missing required key "${key}"`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(obj: Record<string, unknown>, prefix: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!(key in obj)) {
      throw new Error(`config: missing required key "${prefix}.${key}"`);
    }
  }
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

  const monday = requireObject(cfg, 'monday');
  const columns = requireObject(monday, 'columns');
  requireKeys(columns, 'monday.columns', REQUIRED_COLUMNS);

  const resend = requireObject(cfg, 'resend');
  requireKeys(resend, 'resend', REQUIRED_RESEND_KEYS);

  const auth = requireObject(cfg, 'auth');
  requireKeys(auth, 'auth', REQUIRED_AUTH_KEYS);

  const rateLimit = requireObject(cfg, 'rateLimit');
  requireKeys(rateLimit, 'rateLimit', REQUIRED_RATE_LIMIT_KEYS);

  return cfg as unknown as Config;
}
