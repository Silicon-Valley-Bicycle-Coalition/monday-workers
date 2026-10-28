declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OUTBOUND_QUEUE: Queue<{ donorItemId: string }>;
    INBOUND_QUEUE: Queue<{ email: string }>;
    MONDAY_API_TOKEN: string;
    MONDAY_WEBHOOK_SECRET: string;
    MAILCHIMP_API_KEY: string;
    MAILCHIMP_WEBHOOK_SECRET: string;
    SLACK_WEBHOOK_URL?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
    FLAGS: KVNamespace;
  }
}
