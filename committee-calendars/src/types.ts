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

export interface Env {
  DB: D1Database;
  SLACK_WEBHOOK_URL: string;
}
