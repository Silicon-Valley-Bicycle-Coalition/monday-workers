import type { Locale } from './i18n/locales';
import type { WriteStamp } from './flags';
import type { MondayTokenSource } from './monday/graphql';
import type { HomeConfig } from './home/homeState';

export interface MondayColumns {
  donorEmail: string;
  membershipStatus: string;
  membershipTier: string;
  dollarDonated: string;
  donationDonorLink: string;
  donationAmount: string;
  donationDate: string;
  donationDescription: string;
  donationStatus: string;
  discountOffered: string;
  discountActive: string;
  donorAddress: string;
  donorPhone: string;
  membershipExpiry: string;
  preferredLanguage: string;
  // Optional: the People board's Household Email, a second address that also signs a donor in.
  // Absent or the placeholder, sign-in matches Personal Email only.
  donorHouseholdEmail: string;
  donorEmailOptOut: string;
  donorSmsOptOut: string;
  donorDoNotMail: string;
  volunteerDonorLink: string;
  volunteerHours: string;
  volunteerDate: string;
  volunteerJob: string;
  volunteerStatus: string;
  // Optional (GL#115): eventbrite-sync's Ticket Type column ("Shift 1", "Bike valet"), shown after
  // the Job so one person's two shifts at one event don't read as a duplicate. Absent or the
  // placeholder = Job alone.
  volunteerTicketType?: string;
  // DTD (Double the Donation) match columns — gated together by matchLinesEnabled: the first three
  // live on the Donations board, donorDtdLink on the Donors board.
  donationMatchesGift: string;
  donationMatchStatus: string;
  donationMatchedBy: string;
  donorDtdLink: string;
  // People → Employer Name (text). Read only, for the old value on an employer change request;
  // donation-rollups' employerSync writes it from the Current, Primary affiliation.
  donorEmployer: string;
  // Donors-board membership fields for the home page (gated: absent from queries while the
  // placeholder). Member Since is a date, Member Type a status (New / Continuing / Lapsed renewal /
  // Lifetime). The two consent columns are read by the contact-consent card (a later task).
  memberSince: string;
  memberType: string;
  donorEmailConsent: string;
  donorHouseholdEmailConsent: string;
}

// The three donor-facing communication preferences. Each maps to its own gated checkbox column
// on the Donors board (see PREF_FIELD_COLUMNS in config.ts) and doubles as a ChangeRequestField.
export type PrefField = 'emailOptOut' | 'smsOptOut' | 'doNotMail';

// The printed letterhead's sidebar band (SVBC Letter 2026 template in Box), set beside every tax
// letter and organization statement. Each array is one line per entry. The board changes, so it
// lives here rather than in code; update it when the Box template changes.
export interface LetterheadConfig {
  // Website, street, city and phone, top of the band.
  contactLines: string[];
  boardOfDirectors: string[];
  executiveDirector: string;
  // Gold mission tagline, centered at the foot of the first page.
  tagline: string[];
  // Italic 501(c)(3) line, foot of the band.
  nonprofitLines: string[];
}

export interface TaxLetterConfig {
  orgLegalName: string;
  ein: string;
  // The registered/501(c)(3) address. Printed in the letterhead band only when `letterhead` is
  // absent (a fork without its own letterhead); otherwise the band's contactLines stand in.
  officeAddress: string;
  // Where donors mail checks/correspondence — distinct from officeAddress, not currently
  // rendered anywhere (no consumer yet), but kept alongside it so the two addresses don't drift
  // apart or get confused for each other.
  mailingAddress?: string;
  signatureName: string;
  signatureTitle: string;
  plainStatement: string;
  benefitStatement: string;
  benefitTiers: string[];
  // Gift Type labels (the Donations board's text column) a letter treats differently. Excluded
  // gifts are left off entirely and never earn a letter on their own. Separate ones are listed
  // below the total under separateGiftsStatement, not as contributions. Any other label, or a
  // blank, is an ordinary contribution.
  excludedGiftTypes: string[];
  separateGiftTypes: string[];
  separateGiftsStatement: string;
  letterhead?: LetterheadConfig;
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
  // A donor's own employer answer (spec 2026-11-16-donor-employer-answer-design.md). Absent or
  // null turns the Employer field off. Optional so older fixtures and configs stay valid.
  employer?: EmployerAnswerConfig | null;
}

export interface EmployerAffiliationColumns {
  personLink: string;
  organizationLink: string;
  status: string;
  primary: string;
}

export interface EmployerAnswerConfig {
  affiliationsBoardId: number;
  affiliationColumns: EmployerAffiliationColumns;
  currentStatusLabel: string;
  // People → Affiliations connect column: how the writer finds a person's affiliations.
  personAffiliationsLink: string;
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
  // Name of the single staff-edited item on the Letter Settings board that getLetterSettings
  // reads (and scripts/create-letter-settings-board.mjs creates). validateConfig defaults it to
  // 'Letter emails' when the key is absent.
  settingsItemName: string;
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

export interface DonationsConfig {
  // Donations-board status labels that count as real gifts — everywhere: portal donation
  // history, tax-letter gift lists and totals, and the January letter-cron sweep. The board's
  // vocabulary is ['Received', 'Received (Historical)', 'Failed', 'Pending', 'Closed Lost'] (seeded by
  // salesforce-import); only the two Received labels belong here. 'Received (Historical)' is
  // included deliberately — migrated historical gifts are real gifts and belong on tax letters.
  // Unlike volunteerHistory.completedStatuses, an empty array is a config error, not
  // "include everything": silently counting Failed gifts would overstate deductible totals.
  countableStatuses: string[];
  // Calendar-date floor (YYYY-MM-DD) for every donation read — portal history, tax letters,
  // the letter cron. Gifts dated earlier, or undated, are dropped. null means no floor. SVBC
  // starts clean at 2026-01-01 rather than showing migrated Salesforce history.
  historyStartISO: string | null;
  // The UTC date from which the portal shows the Donations tab at all; null means never (see
  // donationHistoryEnabled in config.ts). Independent of the floor: the floor shapes what the
  // reads return, this gate decides whether the portal home asks for them.
  historyVisibleFromISO: string | null;
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

// "Get involved" dashboard links (transit-agency and city committee meetings, SVBC events,
// volunteering). Public pages, not donor data, so production and sandbox may share them.
export type GetInvolvedCategory = 'transit' | 'civic' | 'events' | 'volunteer';

export interface GetInvolvedLink {
  category: GetInvolvedCategory;
  // A committee or agency name, shown untranslated. Omitted for events/volunteer links, which
  // fall back to the category's translated link text.
  label?: string;
  url: string;
  // Optional subscribable ICS feed (svbc-calendars' committees.bikesiliconvalley.org).
  calendarUrl?: string;
}

export interface GetInvolvedConfig {
  // Empty = the dashboard section is omitted.
  links: GetInvolvedLink[];
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

// Org-wide "your giving supported …" statements, keyed by calendar year (v8). An empty
// statementsByYear is the feature's off switch. English is required for every year; any other
// locale is optional and falls back to English (see impact/impact.ts).
export interface ImpactConfig {
  statementsByYear: Record<string, { en: string[] } & Partial<Record<Locale, string[]>>>;
}

// What one donor's section shows: the statements for a single year they gave in.
export interface DonorImpact {
  year: string;
  statements: string[];
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
    // Absolute URL to the branded PNG logo served by GET /email/logo.png (see assets/emailLogo.ts)
    // — differs per environment since it's domain-qualified (member.bikesiliconvalley.org vs the
    // sandbox/local hosts), same reasoning as auth.portalBaseUrl below.
    logoUrl: string;
    // Optional — when set, outbound emails carry this Reply-To instead of the (unmonitored)
    // send-only fromAddress. The sandbox binding strips it regardless (see sandboxBinding.ts).
    replyTo?: string;
  };
  auth: {
    // Interactive login link (POST /): the donor just asked for it and is waiting on the email.
    magicLinkTtlMinutes: number;
    // The "your tax letter is ready" email's login link (processLetterSendBatch) — read whenever
    // the donor gets to it, often days later, so it needs its own, much longer TTL. Still a
    // single-use token in the same magic_link_tokens table. Validated to (0, 168].
    letterLinkTtlHours: number;
    sessionTtlHours: number;
    portalBaseUrl: string;
  };
  // Per-address login-email limits (issue GL#62), on top of the per-IP limiter. Only requests these
  // let through are recorded in login_attempts, so a denied request never extends a lockout.
  rateLimit: {
    // Minimum gap between two login emails to one address.
    emailCooldownSeconds: number;
    emailWindowSeconds: number;
    // Login emails allowed per address per emailWindowSeconds.
    emailMaxAttempts: number;
    // Login emails allowed per address per rolling 24 hours.
    emailDailyMax: number;
    // Wrong sign-in codes allowed per address per rolling 24 hours.
    codeFailuresPerAddressDaily: number;
    // How long login_attempts rows (hashed addresses, donor or not) survive the daily purge.
    // The daily cap reads back 24 hours, so this must be at least that (validated).
    attemptRetentionHours: number;
  };
  taxLetter: TaxLetterConfig;
  changeRequests: ChangeRequestsConfig;
  cardTokens: CardTokensConfig;
  letterCron: LetterCronConfig;
  volunteerHistory: VolunteerHistoryConfig;
  donations: DonationsConfig;
  eventRegistrations: EventRegistrationsConfig;
  funraise: FunraiseConfig;
  getInvolved: GetInvolvedConfig;
  pledges: PledgesConfig;
  matchingGifts: MatchingGiftsConfig;
  impact: ImpactConfig;
  home: HomeConfig;
  organizations: OrganizationsConfig;
}

// Organization reps (spec 2026-11-19-member-portal-organization-reps-design.md). Column ids are
// "REPLACE_WITH_COLUMN_ID" until they exist, which keeps the feature off (orgAccessEnabled).
export interface OrganizationsConfig {
  // Affiliations checkbox "Portal access": staff tick it to let that affiliation's person see the org.
  portalAccessColumn: string;
  // Affiliations "Work Email": the second sign-in address.
  workEmailColumn: string;
  // Organizations street, city and zip columns, in that order. Empty or any placeholder entry = no address line.
  addressColumns: string[];
  // The acknowledgment letter wording and EIN are approved; gates orgAcknowledgmentEnabled.
  acknowledgmentSignedOff: boolean;
  // Employee volunteering shows only as an aggregate of at least this many people.
  volunteerFloor: number;
}

export interface DonorMatch {
  id: string;
  name: string;
  preferredLanguage: string;
  // The address equals the Personal Email (not only the Household Email). Organization sign-in
  // uses it to tell a person's own address from one shared with a household.
  matchedPersonal: boolean;
}

export interface DonationRecord {
  date: string;
  amount: string;
  description: string;
  // An employer's matching gift paired to this one (the latest, if several). Absent/null when
  // unpaired or the feature is gated off.
  match?: { date: string; amount: string; company: string } | null;
  // The donor's own DTD link, set only on an unmatched gift whose Match Status is "Waiting for donor".
  matchHintUrl?: string | null;
}

export interface MemberPortalData {
  id: string;
  name: string;
  membershipStatus: string;
  membershipTier: string;
  totalDonated: string;
  donations: DonationRecord[];
  membershipExpiry: string;
  // '' when the column is gated off (placeholder) or blank.
  memberSince: string;
  memberType: string;
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
  // People → Employer Name; '' when monday.columns.donorEmployer is still the placeholder.
  employer: string;
  // null = that preference's Donors-board checkbox column isn't configured yet (still the
  // placeholder id), so the current state is unknowable — distinct from false (unchecked).
  emailOptOut: boolean | null;
  smsOptOut: boolean | null;
  doNotMail: boolean | null;
}

// A person's two addresses and their Mailchimp consent labels (Subscribed / Unsubscribed /
// Cleaned / ...), for the info door. '' for a blank cell or a column still gated off.
export interface DonorEmails {
  personal: string;
  household: string;
  personalConsent: string;
  householdConsent: string;
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
  donors: MemberPortalData[];
  // How many of the session's donor items failed to load (and so are missing from `donors`).
  // Views show a "some records couldn't be loaded" note when > 0; absent means 0.
  unavailableDonorCount?: number;
  // null when the Organizations read failed — views omit the discounts section rather than
  // show a misleading empty list.
  discounts: DiscountOrganization[] | null;
  // Keyed by donor item id; null when the volunteer-history feature is disabled (unset
  // volunteersBoardId / placeholder column ids) or its Monday read failed. Views render no
  // section for null, a missing key, and an empty shift list alike.
  volunteerHistory: Record<string, DonorVolunteerHistory> | null;
  // false while donations.historyVisibleFromISO hasn't arrived (or is null): loadPortalData
  // skipped the Donations read and views omit the Donations tab — every donor's `donations` is
  // [] and `totalDonated` '' in that state, so rendering them would show a false empty-state.
  donationHistoryEnabled: boolean;
}

// Defined here rather than in changeRequests/submitChangeRequest.ts (which re-exports it for
// that module's own callers) to avoid an import cycle: submitChangeRequest.ts imports
// MondayClient from monday/client.ts, which itself imports from this file.
// `& WriteStamp`: a message enqueued under `off` stays a dry run (src/flags.ts).
export interface ChangeQueueMessage extends WriteStamp {
  requestId: number;
}

// See the comment on ChangeQueueMessage above — same import-cycle avoidance. One queue carries
// both January emails: `kind: 'org'` is an org_statement_sends id (an organization rep's
// statement email), absent is a letter_sends id (a person's tax letter), which every message
// enqueued before organization statements existed is.
export interface LetterSendQueueMessage extends WriteStamp {
  sendId: number;
  kind?: 'org';
}

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates the gitignored worker-configuration.d.ts from wrangler.jsonc —
// a bare `tsc --noEmit` reads a missing or stale copy; see README "Development");
// only secrets, the MONDAY_AUTH binding (typed as the token source the generated Service stands
// in for) and narrowed queue message types are declared here.
export interface Env extends Omit<Cloudflare.Env, 'MONDAY_AUTH'> {
  // Monday access: the monday-auth broker's PortalToken entrypoint (read-only scope) for the
  // portal, SyncToken for member-portal-writer (wrangler.jsonc / wrangler.writer.jsonc services).
  // The fixed MONDAY_API_TOKEN secret is only the fallback while the OAuth cutover is under way;
  // tokenProviderFor (src/monday/graphql.ts) prefers the binding and throws if neither is set.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  EMAIL: SendEmail;
  CHANGE_QUEUE: Queue<ChangeQueueMessage>;
  LETTER_SEND_QUEUE: Queue<LetterSendQueueMessage>;
  LETTER_WEBHOOK_SECRET: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
  // The sandbox email sink (env.sandbox.vars); must equal the send binding's allowlist entry.
  SANDBOX_EMAIL_SINK?: string;
}
