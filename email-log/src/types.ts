import type { LogQueueMessage } from './inbound/extract';
export interface EmailLogConfig {
  monday: {
    apiUrl: string;
    accountUrl: string;
    boards: {
      'activities-logged': number | null;
      'people-live': number | null;
      'people-historical': number | null;
      // null until the Affiliations board exists
      affiliations: number | null;
    };
  };
  // Column ids on Activities (Logged)
  activities: {
    activityTypeColumn: string;
    activityTypeLabel: string;
    dateColumn: string;
    statusColumn: string;
    doneLabel: string;
    needsPersonLabel: string;
    ownerColumn: string;
    personColumn: string;
    notesColumn: string;
    messageHashColumn: string;
  };
  matching: {
    peopleEmailColumns: string[];
    historicalEmailColumns: string[];
    affiliationsWorkEmailColumn: string | null;
    affiliationsPersonColumn: string | null;
  };
  mail: {
    loggingAddress: string;
    staffDomains: string[];
    staffSenders: string[];
    trustedAuthServId: string;
    bodyMaxChars: number;
    maxRawBytes: number;
    forwardTimeZone: string;
    replyFrom: { email: string; name: string };
  };
  capacity: { activitiesMaxItems: number; warnPct: number };
  alerts: { itRequests: { boardId: number; typeColumn: string; typeLabel: string; cooldownDays: number } | null };
}

// Bindings are generated into worker-configuration.d.ts by `wrangler types`; only the narrowed
// queue message type and secrets/vars are declared here.
export interface Env extends Cloudflare.Env {
  DB: D1Database;
  WRITE_QUEUE: Queue<LogQueueMessage>;
  EMAIL: SendEmail;
  MONDAY_API_TOKEN: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
  SANDBOX_EMAIL_SINK?: string;
}
