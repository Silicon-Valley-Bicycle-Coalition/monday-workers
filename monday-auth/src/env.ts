export interface Env {
  DB: D1Database;
  ENVIRONMENT: 'production' | 'sandbox';
  EXPECTED_USER_ID: string;
  MONDAY_SUBDOMAIN: string;
  START_KEY: string;
  // AES-256-GCM key (32 bytes, base64) for the token columns in D1. Optional in the type so a
  // missing secret is TokenCipher.load's clear refusal rather than a type lie.
  TOKEN_ENC_KEY?: string;
  // Attempt limiter for /oauth/*, keyed on CF-Connecting-IP. Absent in unit tests.
  REQUEST_RATE_LIMITER?: RateLimit;
  // "true" enables /oauth/probe; anything else makes it 404.
  PROBE_ENABLED?: string;
  // "true" enables /oauth/webhooks; anything else makes it 404.
  WEBHOOKS_ENABLED?: string;
  // Comma-separated https://host/path/ prefixes a webhook created through /oauth/webhooks may point at.
  WEBHOOK_URL_PREFIXES?: string;
  SLACK_WEBHOOK_URL?: string;
  PORTAL_CLIENT_ID: string;
  PORTAL_CLIENT_SECRET: string;
  SYNC_CLIENT_ID: string;
  SYNC_CLIENT_SECRET: string;
  READONLY_CLIENT_ID: string;
  READONLY_CLIENT_SECRET: string;
}
