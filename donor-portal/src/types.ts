import type { Locale } from './i18n/locales';

export interface MondayColumns {
  donorEmail: string;
  membershipStatus: string;
  membershipTier: string;
  dollarDonated: string;
  donationDonorLink: string;
  donationAmount: string;
  donationDate: string;
  donationDescription: string;
  discountOffered: string;
  discountActive: string;
  donorAddress: string;
  donorPhone: string;
  membershipExpiry: string;
  preferredLanguage: string;
}

export interface TaxLetterConfig {
  orgLegalName: string;
  ein: string;
  orgAddress: string;
  signatureName: string;
  signatureTitle: string;
  plainStatement: string;
  benefitStatement: string;
  benefitTiers: string[];
}

export interface ChangeRequestColumns {
  donorLink: string;
  field: string;
  oldValue: string;
  newValue: string;
  submittedAt: string;
}

export interface ChangeRequestsConfig {
  boardId: number | null;
  columns: ChangeRequestColumns;
  dedupeWindowHours: number;
  retentionDays: number;
}

export interface CardTokensConfig {
  retentionDays: number;
}

export interface LetterCronColumns {
  autoSend: string;
  startDate: string;
  // The default/fallback template column, used for any locale without its own entry below.
  bodyTemplate: string;
  // Optional per-locale template columns (created by scripts/create-letter-settings-board.mjs
  // --add-locale-columns). A locale absent here, or whose column is blank, falls back to
  // bodyTemplate, then to the localized built-in copy.
  bodyTemplatesByLocale: Partial<Record<Locale, string>>;
}

export interface LetterCronConfig {
  boardId: number | null;
  columns: LetterCronColumns;
  maxTriggersPerRun: number;
}

// The staff-editable state read from the Letter Settings board at cron time (and, for the
// templates, per letter-email batch) — see scripts/create-letter-settings-board.mjs.
export interface LetterSettings {
  autoSend: boolean;
  startDate: string; // 'YYYY-MM-DD', or '' when the date column is empty
  bodyTemplate: string;
  // Only locales whose column holds text appear here — blank columns are omitted so callers
  // fall through to bodyTemplate.
  bodyTemplatesByLocale: Partial<Record<Locale, string>>;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    donationsBoardId: number | null;
    organizationsBoardId: number | null;
    columns: MondayColumns;
  };
  email: {
    fromAddress: string;
    fromName: string;
  };
  auth: {
    magicLinkTtlMinutes: number;
    sessionTtlHours: number;
    portalBaseUrl: string;
  };
  rateLimit: {
    emailWindowSeconds: number;
    emailMaxAttempts: number;
  };
  taxLetter: TaxLetterConfig;
  changeRequests: ChangeRequestsConfig;
  cardTokens: CardTokensConfig;
  letterCron: LetterCronConfig;
}

export interface DonorMatch {
  id: string;
  name: string;
  preferredLanguage: string;
}

export interface DonationRecord {
  date: string;
  amount: string;
  description: string;
}

export interface DonorPortalData {
  id: string;
  name: string;
  membershipStatus: string;
  membershipTier: string;
  totalDonated: string;
  donations: DonationRecord[];
  membershipExpiry: string;
}

export interface DiscountOrganization {
  name: string;
  discountOffered: string;
}

export interface DonorContactInfo {
  id: string;
  name: string;
  email: string;
  address: string;
  phone: string;
  preferredLanguage: string;
}

export interface PortalView {
  donors: DonorPortalData[];
  discounts: DiscountOrganization[];
}

// Defined here rather than in changeRequests/submitChangeRequest.ts (which re-exports it for
// that module's own callers) to avoid an import cycle: submitChangeRequest.ts imports
// MondayClient from monday/client.ts, which itself imports from this file.
export interface ChangeQueueMessage {
  requestId: number;
}

// See the comment on ChangeQueueMessage above — same import-cycle avoidance.
export interface LetterSendQueueMessage {
  sendId: number;
}

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message types are declared here.
export interface Env extends Cloudflare.Env {
  MONDAY_API_TOKEN: string;
  EMAIL: SendEmail;
  CHANGE_QUEUE: Queue<ChangeQueueMessage>;
  LETTER_SEND_QUEUE: Queue<LetterSendQueueMessage>;
  LETTER_WEBHOOK_SECRET: string;
}
