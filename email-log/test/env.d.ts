declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    WRITE_QUEUE: Queue<import('../src/inbound/extract').LogQueueMessage>;
    EMAIL: SendEmail;
    MONDAY_API_TOKEN?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
    SANDBOX_EMAIL_SINK?: string;
    FLAGS: KVNamespace;
  }
}
