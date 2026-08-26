declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OUTBOUND_QUEUE: Queue<{ donorItemId: string }>;
    INBOUND_QUEUE: Queue<{ email: string }>;
    MONDAY_API_TOKEN: string;
    MAILCHIMP_API_KEY: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
