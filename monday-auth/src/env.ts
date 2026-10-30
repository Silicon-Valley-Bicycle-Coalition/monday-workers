export interface Env {
  DB: D1Database;
  ENVIRONMENT: 'production' | 'sandbox';
  EXPECTED_USER_ID: string;
  MONDAY_SUBDOMAIN: string;
  START_KEY: string;
  // "true" enables /oauth/probe; anything else makes it 404.
  PROBE_ENABLED?: string;
  SLACK_WEBHOOK_URL?: string;
  PORTAL_CLIENT_ID: string;
  PORTAL_CLIENT_SECRET: string;
  SYNC_CLIENT_ID: string;
  SYNC_CLIENT_SECRET: string;
  READONLY_CLIENT_ID: string;
  READONLY_CLIENT_SECRET: string;
}
