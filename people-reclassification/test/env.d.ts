declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MONDAY_API_TOKEN: string;
    RECLASSIFY_SECRET?: string;
    DRY_RUN?: string;
    REQUEST_RATE_LIMITER: RateLimit;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
  }
}
