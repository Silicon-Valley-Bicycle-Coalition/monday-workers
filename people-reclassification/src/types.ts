import type { MondayTokenSource } from './monday/graphql';
// A column is named by its title, not its id: salesforce-import creates both People boards from
// one column spec, so titles agree across them while ids differ per board, and the move's
// columns_mapping is built from the same title match (src/columns.ts). Titles are resolved to
// ids once per pass.
export interface BoardRef { boardId: number; groupId: string | null }

export interface PeopleColumns {
  lastGift: string;        // date — donation-rollups' Last Gift Date rollup
  memberUntil: string;     // date — Member Until (import + donation-rollups' renewal path)
  membershipTier: string;  // status — Lifetime = never ages out
  funraiseProfile: string | null; // link — a linked Funraise supporter never ages out (import rule)
  promoteStatus: string;   // status — staff set the request label to promote someone (src/promote.ts)
  promotedOn: string;      // date — written by a promotion; counts as activity
}

export interface EventRegistrationsConfig {
  boardId: number;
  columns: { attendee: string; event: string; attendance: string; source: string };
  // A registration counts as activity when its Attendance label is one of these …
  countedAttendanceLabels: string[];
  // … or its Source is one of these, whatever the Attendance (a Funraise registration is a paid
  // ticket; an Eventbrite registration counts only once checked in — import decision 2026-09-08).
  countedRegisteredSources: string[];
  events: { boardId: number; startColumn: string };
}

export interface VolunteersConfig {
  boardId: number;
  columns: { volunteer: string; date: string };
}

// The go-forward activity board: calls and meetings staff log by hand, and the emails logged there
// before log@ was retired (2026-11-04). A logged item counts as activity when its Activity Type
// label is one of countedTypeLabels, which leaves out Bulk Email (a mail-merge send, not a contact).
export interface LoggedActivitiesConfig {
  boardId: number;
  columns: { person: string; date: string; activityType: string };
  countedTypeLabels: string[];
}

export interface PromoteConfig { requestLabel: string; doneLabel: string; failedLabel: string }

export interface ItRequestsAlertConfig {
  boardId: number;
  typeColumn: string;   // status column title
  typeLabel: string;
  cooldownDays: number;
}

export interface ReclassificationConfig {
  monday: { apiUrl: string; accountUrl: string; accountId?: number };
  window: { years: number; timeZone: string };
  boards: { live: BoardRef; historical: BoardRef };
  peopleColumns: PeopleColumns;
  perpetual: { lifetimeTierLabel: string; funraiseLinked: boolean };
  eventRegistrations: EventRegistrationsConfig | null;
  volunteers: VolunteersConfig | null;
  loggedActivities: LoggedActivitiesConfig | null;
  promote: PromoteConfig;
  thresholds: { itemsLimit: number; liveTriggerPct: number; historicalWarnPct: number };
  run: { maxMovesPerRun: number; quarterlyMonths: number[]; cronHourUTC: number };
  alerts: { itRequests: ItRequestsAlertConfig | null };
}

export interface Env {
  DB: D1Database;
  // Monday access: the monday-auth broker's SyncToken entrypoint (wrangler.jsonc services). The
  // fixed MONDAY_API_TOKEN secret is only the fallback while the OAuth cutover is under way;
  // tokenProviderFor (src/monday/graphql.ts) prefers the binding and throws if neither is set.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  // Shared secret for the /reclassify/* routes (Authorization: Bearer …); unset = routes disabled.
  RECLASSIFY_SECRET?: string;
  // Shared secret on the registered Monday webhook URL (?secret=…); unset = route disabled.
  PROMOTE_WEBHOOK_SECRET?: string;
  // Staff sync app's Signing Secret (issue GL#110, src/mondayJwt.ts): set = verify any webhook JWT
  // present; MONDAY_WEBHOOK_JWT_REQUIRED = "true" (a var) also rejects deliveries without one.
  MONDAY_SIGNING_SECRET?: string;
  MONDAY_WEBHOOK_JWT_REQUIRED?: string;
  // Write switch (`people-reclassification:writes` = on | hold | off), see src/flags.ts.
  FLAGS: KVNamespace;
  REQUEST_RATE_LIMITER: RateLimit;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}
