declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SYNC_QUEUE: Queue<{ direction: 'qb-to-monday' | 'monday-to-qb'; eventId: string; writeStamp?: 'dropped' }>;
    FLAGS: KVNamespace;
    MONDAY_API_TOKEN?: string;
    QB_CLIENT_ID: string;
    QB_CLIENT_SECRET: string;
    QB_WEBHOOK_VERIFIER_TOKEN: string;
    QB_TOKEN_ENCRYPTION_KEY?: string;
    MONDAY_WEBHOOK_SECRET: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
  }
}
