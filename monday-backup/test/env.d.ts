declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FLAGS: KVNamespace;
    MONDAY_API_TOKEN?: string;
    GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
    SLACK_WEBHOOK_URL: string;
    ENVIRONMENT?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
