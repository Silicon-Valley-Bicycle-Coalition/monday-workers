declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    WRITE_QUEUE: Queue<{
      messageIdHash: string;
      kind: 'bcc' | 'forward';
      staffEmail: string;
      counterparts: string[];
      subject: string;
      dateISO: string;
      body: string;
      attachmentNames: string[];
    }>;
    EMAIL: SendEmail;
    MONDAY_API_TOKEN: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    ENVIRONMENT?: string;
    SANDBOX_EMAIL_SINK?: string;
  }
}
