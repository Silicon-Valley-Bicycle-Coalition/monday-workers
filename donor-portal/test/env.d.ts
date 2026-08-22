declare module 'cloudflare:test' {
  export interface D1Migration {
    name: string;
    content: string;
  }

  export function applyD1Migrations(db: D1Database, migrations: D1Migration[]): Promise<void>;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MONDAY_API_TOKEN: string;
    RESEND_API_KEY: string;
    LOGIN_RATE_LIMITER: RateLimit;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
