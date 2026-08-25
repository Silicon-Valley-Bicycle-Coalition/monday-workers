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
  donorEmailOptOut: string;
  donorSmsOptOut: string;
  donorDoNotMail: string;
  volunteerDonorLink: string;
  volunteerHours: string;
  volunteerDate: string;
  volunteerJob: string;
  volunteerStatus: string;
}

// The three donor-facing communication preferences. Each maps to its own gated checkbox column
// on the Donors board (see PREF_FIELD_COLUMNS in config.ts) and doubles as a ChangeRequestField.
export type PrefField = 'emailOptOut' | 'smsOptOut' | 'doNotMail';

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

export interface VolunteerHistoryConfig {
  // Shift statuses that count toward the portal's volunteer history (both the listed shifts and
  // the total-hours sum). An empty array means "include every status" — for orgs whose
  // Volunteers board has no status column semantics worth filtering on.
  completedStatuses: string[];
}

export interface EventRegistrationColumns {
  attendeeLink: string;
  eventLink: string;
  attended: string;
}

export interface EventRegistrationsConfig {
  boardId: number | null;
  columns: EventRegistrationColumns;
  eventDateColumnId: string;
}

export interface FunraiseConfig {
  manageRecurringUrl: string;
  renewMembershipUrl: string;
}

// The resolved, per-link view of FunraiseConfig: null means "not configured, don't render the
// link" (see funraiseLinks() in config.ts).
export interface FunraiseLinkUrls {
  manageRecurringUrl: string | null;
  renewMembershipUrl: string | null;
}

export interface PledgeColumns {
  donorLink: string;
  pledgedAmount: string;
  fulfilledAmount: string;
  status: string;
  dueDate: string;
}

export interface PledgesConfig {
  boardId: number | null;
  columns: PledgeColumns;
}

export interface MatchingGiftsConfig {
  // Double the Donation *public* plugin key — safe to render into HTML by design (it's what
  // their embed snippet ships to every visitor's browser). Never put a private DTD key here.
  doubleTheDonationPublicKey: string | null;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    donationsBoardId: number | null;
    organizationsBoardId: number | null;
    volunteersBoardId: number | null;
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
  volunteerHistory: VolunteerHistoryConfig;
  eventRegistrations: EventRegistrationsConfig;
  funraise: FunraiseConfig;
  pledges: PledgesConfig;
  matchingGifts: MatchingGiftsConfig;
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

export interface EventRegistrationRecord {
  registrationName: string;
  eventName: string;
  eventDate: string;
  attended: boolean;
}

// All five fields are Monday column text passed through verbatim (same convention as
// DonationRecord) — amounts stay display strings; any numeric interpretation happens in
// pledges/loadPledgeData, not here.
export interface PledgeRecord {
  name: string;
  pledged: string;
  fulfilled: string;
  status: string;
  dueDate: string;
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
  // null = that preference's Donors-board checkbox column isn't configured yet (still the
  // placeholder id), so the current state is unknowable — distinct from false (unchecked).
  emailOptOut: boolean | null;
  smsOptOut: boolean | null;
  doNotMail: boolean | null;
}

export interface VolunteerShift {
  date: string;
  hours: string;
  job: string;
  status: string;
}

export interface DonorVolunteerHistory {
  shifts: VolunteerShift[];
  totalHours: number;
}

export interface PortalView {
  donors: DonorPortalData[];
  discounts: DiscountOrganization[];
  // Keyed by donor item id; null when the volunteer-history feature is disabled (unset
  // volunteersBoardId / placeholder column ids) or its Monday read failed. Views render no
  // section for null, a missing key, and an empty shift list alike.
  volunteerHistory: Record<string, DonorVolunteerHistory> | null;
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
