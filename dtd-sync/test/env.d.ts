declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FLAGS: KVNamespace;
    MONDAY_API_TOKEN?: string;
    // Worker secret (wrangler secret put DTD_PRIVATE_KEY). Never in a file, log line or D1 row.
    DTD_PRIVATE_KEY?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
  }
}
