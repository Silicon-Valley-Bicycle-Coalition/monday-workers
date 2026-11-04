import type { MondayTokenSource } from './monday/graphql';
import type { WriteQueueMessage } from './consumer/processBatch';

// Ledger statuses. 'received'/'queued' are the route's; the consumer ends a row at 'written'
// (a Donations item exists for it), 'skipped' (not giving: unmapped status or a free order — see
// docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md) or 'failed'.
export type OrderStatus = 'received' | 'queued' | 'written' | 'skipped' | 'failed';

// One row per Eventbrite order this Worker has heard about. Deliberately no name, email or
// payload: the consumer re-fetches the order from Eventbrite on every run, so nothing personal
// needs to sit in D1 and there is no retention purge.
export interface OrderRow {
  orderId: string;
  eventId: string | null;
  lastAction: string;
  status: OrderStatus;
  eventbriteStatus: string | null;
  amount: string | null;
  currency: string | null;
  orderCreated: string | null;
  matchedDonorItemId: string | null;
  mondayItemId: string | null;
  error: string | null;
  deliveries: number;
  receivedAt: string;
  writtenAt: string | null;
}

// The attendee/event ledgers reuse the order statuses: received → queued → written | skipped | failed.
export type LedgerStatus = OrderStatus;

// One row per Eventbrite event this Worker has heard about. Ids, times and statuses only — no
// payload, as with orders.
export interface EventRow {
  eventId: string;
  mondayItemId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  locationKey: string | null;
  eventbriteStatus: string | null;
  status: LedgerStatus;
  lastAction: string;
  error: string | null;
  deliveries: number;
  receivedAt: string;
  writtenAt: string | null;
}

// One row per Eventbrite attendee. No name or email: the consumer re-fetches the attendee.
export interface AttendeeRow {
  attendeeId: string;
  eventId: string;
  mondayItemId: string | null;
  matchedPersonItemId: string | null;
  status: LedgerStatus;
  lastAction: string;
  error: string | null;
  deliveries: number;
  receivedAt: string;
  writtenAt: string | null;
}

export interface MondayBoards {
  'donations:live': number | null;
  'people-live': number | null;
  events: number | null;
  'event-registrations': number | null;
}

export type AmountSource = 'gross' | 'base_price';

export interface EventbriteSyncConfig {
  monday: {
    apiUrl: string;
    boards: MondayBoards;
  };
  eventbrite: {
    // Base of the v3 API, no trailing slash. The route also requires every delivery's api_url
    // to start with it (webhook/validate.ts), so a fork pointing at a mock server sets it once.
    apiUrl: string;
    // SVBC's Eventbrite organization id. When set, a delivery whose config.user_id names a
    // different organization is acknowledged and ignored. Also what scripts/backfill-orders.mjs
    // lists orders under. null skips the check.
    organizationId: string | null;
    // Webhook actions this Worker processes; anything else is acknowledged and ignored.
    actions: string[];
  };
  eventbriteSync: {
    // Text column on the Donations board holding the bare Eventbrite order id: the idempotency
    // key and the adopt-before-create lookup key. Required — the consumer refuses to write while
    // this is the REPLACE_WITH_COLUMN_ID placeholder (the column is a prerequisite; README).
    orderIdColumn: string;
    amountColumn: string;
    statusColumn: string;
    dateColumn: string;
    // Which Eventbrite cost the Amount is: `gross` (what the buyer paid, fees and tax included —
    // SVBC's choice, spec decision 6) or `base_price` (organizer revenue net of Eventbrite fees).
    amountSource: AmountSource;
    // The currency the Donations Amount column is in (ISO 4217, "USD"). An order whose cost is in
    // any other currency is not written: it is recorded failed for a human, never as dollars.
    currency: string;
    // A free order (amount 0) with no Donations item yet is not giving: mark it skipped. An
    // order already on the board is always updated regardless.
    skipFreeOrders: boolean;
    // Eventbrite order status → Donations Status label. An unmapped status is skipped, never
    // written — `started`, `pending` and `abandoned` are not money.
    statusLabelMap: Record<string, string>;
    // Donations item name; placeholders {buyer}, {event}, {orderId}.
    itemNameTemplate: string;
    // First-write stamps, each null to disable — same semantics as funraise-sync.
    thankYouSentColumn: string | null;
    giftTypeColumn: string | null;
    giftTypeValue: string;
    fiscalYearColumn: string | null;
    // People board email column (lookup by bare address; create writes { email, text }) and the
    // Donations board's Donor connect column.
    donorEmailColumn: string;
    donorFirstNameColumn: string;
    donorLastNameColumn: string;
    donorLinkColumn: string;
  };
  // The attendee/event feed: Eventbrite events → Events board, attendees → Event Registrations,
  // and the class follow-up emails (docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md).
  attendeeSync: {
    // Webhook actions the attendee/event route processes; anything else is acknowledged and ignored.
    actions: string[];
    // Eventbrite organizer id → Program label (Events board Program column). Unlisted = Public.
    programByOrganizer: Record<string, string>;
    // Programs whose attendees get Role = Volunteer.
    volunteerPrograms: string[];
    events: {
      eventbriteIdColumn: string;
      dateColumn: string;
      endColumn: string;
      venueColumn: string;
      addressColumn: string;
      cityColumn: string;
      programColumn: string;
      eventStatusColumn: string;
      sourceColumn: string;
      urlColumn: string;
      classTypeColumn: string;
      followupsColumn: string;
    };
    registrations: {
      attendeeIdColumn: string;
      attendeeNameColumn: string;
      attendeeEmailColumn: string;
      firstNameColumn: string;
      attendanceColumn: string;
      sourceColumn: string;
      roleColumn: string;
      eventLinkColumn: string;
      attendeeLinkColumn: string;
      classDateColumn: string;
      classDayColumn: string;
      classLocationColumn: string;
      classTypeColumn: string;
      followupEmailColumn: string;
    };
    // People board email column used to match attendees to People.
    peopleEmailColumn: string;
    followups: {
      // Events that ended more than this many days ago are not sent follow-ups.
      maxAgeDays: number;
      // Local (America/Los_Angeles) hour at which the daily follow-up sweep sends.
      sendHourLocal: number;
      // Monday user notified when follow-ups are Held; null disables the notification.
      notifyUserId: number | null;
    };
  };
}

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets, the narrowed queue message type, and MONDAY_AUTH are declared here. MONDAY_AUTH is
// generated as an untyped Service, so it is omitted and restated as the broker's RPC shape.
export interface Env extends Omit<Cloudflare.Env, 'MONDAY_AUTH'> {
  WRITE_QUEUE: Queue<WriteQueueMessage>;
  // Monday access: the monday-auth broker's SyncToken entrypoint (wrangler.jsonc services). The
  // fixed MONDAY_API_TOKEN secret is only the fallback while the OAuth cutover is under way;
  // tokenProviderFor (src/monday/graphql.ts) prefers the binding and throws if neither is set.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  // Eventbrite private token (`wrangler secret put EVENTBRITE_PRIVATE_TOKEN`), sent as
  // `Authorization: Bearer` on every order fetch. Optional in the type because secrets aren't
  // declared in wrangler.jsonc; the consumer fails every message (retry, then DLQ) until it is set.
  EVENTBRITE_PRIVATE_TOKEN?: string;
  // Shared secret required as `?secret=...` on the registered webhook URL, or as the
  // X-Webhook-Secret header (`wrangler secret put EVENTBRITE_WEBHOOK_SECRET`). The route fails
  // closed (401 on every delivery) until it is set.
  EVENTBRITE_WEBHOOK_SECRET?: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}
