declare namespace Cloudflare {
  interface Env {
    FLAGS: KVNamespace;
    MONDAY_AUTH: Fetcher;
    ENVIRONMENT?: string;
  }
}
