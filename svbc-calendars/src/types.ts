export interface NormalizedEvent {
  sourceId: string;
  externalId: string;
  title: string;
  committeeName: string;
  startUtc: string; // ISO 8601, UTC
  endUtc: string | null;
  location: string | null;
  url: string | null;
  description?: string | null;
  // Eventbrite-only fields, populated by src/adapters/eventbrite.ts and consumed only by
  // src/eventsApi.ts (the /events JSON API and /widget HTML) for its richer display — ics.ts
  // ignores all of these when building a calendar's .ics output.
  startLocal?: string;
  endLocal?: string;
  timezone?: string;
  isFree?: boolean;
  onlineEvent?: boolean;
  summary?: string | null;
  logoUrl?: string | null;
  venueName?: string | null;
  venueCity?: string | null;
  venueAddress?: string | null;
}

export interface LegistarSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'legistar';
  client: string;
  bodyId: number;
}

export interface CivicPlusSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'civicplus';
  domain: string;
  catId: number;
}

export interface CaltrainBatacSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'caltrainBatac';
  pageUrl: string;
  titleFilter: string;
}

export interface EventbriteSourceConfig {
  id: string;
  name: string;
  committeeName: string;
  adapter: 'eventbrite';
  organizerId: string;
}

export type SourceConfig = LegistarSourceConfig | CivicPlusSourceConfig | CaltrainBatacSourceConfig | EventbriteSourceConfig;

export interface CalendarsConfig {
  sources: SourceConfig[];
}

export interface SourceStatus {
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
}

/** Environment bindings declared in wrangler.jsonc, plus secrets. */
export interface Env {
  EVENTBRITE_ORG_ID: string;
  /** /events, /widget edge-cache TTL in seconds (existing behavior, unchanged: 900 = 15 min). */
  CACHE_TTL: string;
  /** /calendars/*.ics, /calendars edge-cache TTL in seconds (new: 86400 = 24h — "nothing needs to be real-time"). */
  CALENDAR_CACHE_TTL: string;
  /** Bump to invalidate the edge cache on deploy. */
  CACHE_VERSION: string;
  /** Cloudflare Web Analytics site token; omit/empty to skip the beacon script. */
  CF_WEB_ANALYTICS_TOKEN?: string;
  /** Eventbrite private OAuth token (set via `wrangler secret put`). */
  EVENTBRITE_TOKEN: string;
  /** Slack incoming-webhook URL for source-failure alerts (set via `wrangler secret put`). */
  SLACK_WEBHOOK_URL: string;
  /** Last-known-good ICS + per-source failure-streak status. */
  CALENDAR_KV: KVNamespace;
  /** Per-route, per-source usage/health metrics. */
  CALENDAR_ANALYTICS: AnalyticsEngineDataset;
  /** Provisioned in wrangler.jsonc — see README "Reliability: traffic and cost limits". */
  REQUEST_RATE_LIMITER: RateLimit;
}
