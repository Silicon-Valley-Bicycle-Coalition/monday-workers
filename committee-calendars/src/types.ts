export interface NormalizedEvent {
  sourceId: string;
  externalId: string;
  title: string;
  committeeName: string;
  startUtc: string; // ISO 8601, UTC
  endUtc: string | null;
  location: string | null;
  url: string | null;
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

export type SourceConfig = LegistarSourceConfig | CivicPlusSourceConfig | CaltrainBatacSourceConfig;

export interface CommitteeCalendarsConfig {
  sources: SourceConfig[];
}

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message types are declared here.
export interface Env extends Cloudflare.Env {
  SLACK_WEBHOOK_URL: string;
}
