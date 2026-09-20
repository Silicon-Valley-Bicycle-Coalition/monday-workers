import type { BenevityQueueMessage } from '../src/consumer/processBatch';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      WRITE_QUEUE: Queue<BenevityQueueMessage>;
      MONDAY_API_TOKEN: string;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
      ENVIRONMENT?: string;
    }
  }
}
