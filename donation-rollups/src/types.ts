// One entry per Donations *era* board — salesforce-import splits donation history across
// several boards to stay under Monday's 10k-item ceiling (a "live" current-era board plus
// several dated historical ones), and each is an independently created board with its own
// column-id namespace even though they're structurally identical. Confirmed against the
// real CRM Sandbox workspace 2026-08-24: 9 Donations boards, no two sharing a column id.
export interface DonationBoardConfig {
  boardId: number;
  columns: {
    donorLink: string;
    amount: string;
    date: string;
    fiscalYear: string | null; // null where the column doesn't exist yet — derived from date instead
    status: string;
    // Optional: refreshes the gifts ledger's gift_type from Monday when configured.
    giftType?: string | null;
    // Membership term columns on the gift (spec "Writes and idempotency"). Required, and
    // giftType required, whenever donationRollups.membership is configured.
    termStart?: string | null;
    termEnd?: string | null;
    membershipType?: string | null;
    actingForLink: string | null;
  };
}

export interface CustodianConfig {
  // How many fiscal years of donations stay active (unarchived) on the Donations board —
  // must match salesforce-import's donationsActiveFiscalYears so the custodian's year-end
  // run continues exactly the policy the initial load established. 2 = current + previous.
  activeFiscalYears: number;
  // Workspace whose boards the capacity alarm watches (every board, not just donations).
  workspaceId: number;
  capacityAlertPct: number;
  // Monday item to post alert updates on (e.g. the IT Requests tracker) — null = log-only.
  alertItemId: number | null;
  // Annual Giving Summary board (docs/20 §5.4) — null until that board exists; summaries
  // still materialize into D1's annual_summaries either way. Column ids come with it.
  annualSummaryBoardId: number | null;
  annualSummaryColumns: { fiscalYear: string; total: string; giftCount: string; byType: string; restatedAt: string } | null;
}

export interface AffiliationsConfig {
  boardId: number;
  columns: {
    personLink: string;          // Affiliations board: connect → People / People (Historical)
    attributedGiving: string;    // numbers (currency)
    attributedGiftCount: string; // numbers
    lastAttributedGift: string;  // date
  };
}

// The org's fiscal year (issue #27): which month it starts in and which time zone "today" is
// read in, so This/Last Year and the custodian's July sweep/archive roll over at local
// midnight. SVBC: { startMonth: 7, timeZone: "America/Los_Angeles" }.
export interface FiscalYearConfig {
  startMonth: number; // 1-12; a fiscal year is named for the calendar year it ends in
  timeZone: string;   // IANA zone, e.g. "America/Los_Angeles"
}

export interface DonationRollupsConfig {
  // accountUrl builds the deep links in gift-history projections (docs/20 §5.5).
  monday: { apiUrl: string; accountUrl: string };
  fiscalYear: FiscalYearConfig;
  custodian: CustodianConfig;
  affiliations: AffiliationsConfig | null;
  donationRollups: {
    donationBoards: DonationBoardConfig[];
    receivedStatusLabel: string;
    // Keyed by the real Monday board id (as a string), not a "donors"/"organizations"
    // category — confirmed against the real CRM Sandbox 2026-08-24 that a Donation's
    // "Donor" connect column can point at three separate boards (People, People
    // Historical, Organizations), each with its own independent column-id namespace
    // even for identically-named/purposed fields. Every board a Donation can link an
    // owner to needs an entry here.
    ownerColumnsByBoard: Record<string, OwnerColumns>;
    membership: MembershipConfig | null;
  };
}

export interface OwnerColumns {
  // Machine-readable gift-history projection (docs/20 §5.5) — a text column.
  giftLedgerJson: string;
  lifetimeGiving: string;
  giftCount: string;
  firstGift: string;
  thisYearAmount: string;
  thisYearCount: string;
  lastYearAmount: string;
  lastYearCount: string;
  largestGift: string;
  smallestGift: string;
  averageGift: string;
  lastGiftDate: string;
  lastGiftAmount: string;
  membership?: OwnerMembershipColumns;
  organizationalGiving?: string;   // People boards only — Organizations have no driven-giving concept.
}

// The four membership columns on a People-type owner board. Absent on Organizations: an
// owner whose board has no entry never gets a membership write (spec "The rule").
export interface OwnerMembershipColumns {
  status: string;
  tier: string;
  since: string;
  until: string;
}

// donationRollups.membership — the Create_members rule, in Monday terms. null = feature off.
export interface MembershipConfig {
  fromISO: string;
  eligibleGiftTypes: string[];
  termMonths: number;
  lifetimeThresholdCents: number;
  statusLabels: { active: string; lapsed: string };
  tierLabels: { member: string; lifetime: string };
  typeLabels: { new: string; renewal: string; reacquire: string; lifetime: string };
}

// donationRollups.donorLevel — the Salesforce "Major (Lifetime >= 500 or Largest > 200)" and
// "Major Donors (+5K)" report definitions as one status (spec 2026-09-29 §4). null = feature off.
export interface DonorLevelConfig {
  leadershipLifetimeCents: number;
  majorLifetimeCents: number;
  majorLargestCents: number;
  labels: { leadership: string; major: string; donor: string };
}

export type PendingStatus = 'received' | 'queued' | 'written' | 'failed';

export interface PendingRow {
  donationItemId: string;
  donationBoardId: string;
  eventId: string;
  status: PendingStatus;
  ownerItemId: string | null;
  ownerBoard: string | null; // the real Monday board id the owner lives on
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface Env {
  DB: D1Database;
  RECOMPUTE_QUEUE: Queue<RecomputeQueueMessage>;
  MONDAY_API_TOKEN: string;
  MONDAY_WEBHOOK_SECRET?: string;
  // Provisioned in wrangler.jsonc — see README "Reliability: traffic and cost limits".
  REQUEST_RATE_LIMITER: RateLimit;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}

export interface RecomputeQueueMessage {
  donationItemId: string;
  // Which Donations *era* board this donation lives on — needed to resolve its Donor
  // link using that board's own column ids (see DonationBoardConfig).
  donationBoardId: string;
  // Set when this message recomputes a specific OWNER rather than resolving one from the
  // donation: the owner a gift just moved away from (issue #26). donationItemId is then the gift
  // that left, kept for logs. Always recomputed — never coalesced away.
  ownerItemId?: string;
  ownerBoardId?: string;
}
