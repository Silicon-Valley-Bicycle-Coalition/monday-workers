declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    WRITE_QUEUE: Queue<{ eventId: string; writeStamp?: 'dropped' }>;
    FLAGS: KVNamespace;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ZOOM_WEBHOOK_SECRET?: string;
    ENVIRONMENT?: string;
  }
}
