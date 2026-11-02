import type { WriteStamp } from './flags';

// Which of the three source boards a contact came from. 'historical' is People (Historical).
export type ContactKind = 'person' | 'historical' | 'organization';

// One queued write: connect one matched contact to a search's results-board row. The `stamp`
// carries the write-switch mode at enqueue time (see flags.ts messageDisposition).
export interface WriteMessage {
  boardId: number;
  label: string;
  contactId: string;
  kind: ContactKind;
  name: string;
  stamp: WriteStamp;
}

export interface Env {
  DB: D1Database;
  WRITES: Queue<WriteMessage>;
  FLAGS: KVNamespace;
  MONDAY_AUTH: Fetcher;
  REQUEST_RATE_LIMITER: RateLimit;
  ENVIRONMENT?: string;
}
