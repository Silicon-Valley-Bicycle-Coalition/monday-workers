declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    RECOMPUTE_QUEUE: Queue<{ donationItemId: string; writeStamp?: 'dropped' }>;
    FLAGS: KVNamespace;
    MONDAY_API_TOKEN?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
  }
}
