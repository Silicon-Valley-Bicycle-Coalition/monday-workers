declare namespace Cloudflare {
  interface Env {
    EMAIL: SendEmail;
    MONDAY_API_TOKEN: string;
    DIGESTS_SECRET?: string;
    REQUEST_RATE_LIMITER: RateLimit;
    ENVIRONMENT?: string;
    SANDBOX_EMAIL_SINK?: string;
    FLAGS: KVNamespace;
  }
}
