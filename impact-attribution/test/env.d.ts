declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FLAGS: KVNamespace;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
  }
}
