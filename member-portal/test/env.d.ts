declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MONDAY_API_TOKEN: string;
    EMAIL: SendEmail;
    LOGIN_RATE_LIMITER: RateLimit;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
    SANDBOX_EMAIL_SINK?: string;
  }
}
