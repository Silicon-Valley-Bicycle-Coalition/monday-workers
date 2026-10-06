declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    WRITE_QUEUE: Queue<{ orderId: string; action: string }>;
    MONDAY_API_TOKEN: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
  }
}
