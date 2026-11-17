export interface Env {
  ENVIRONMENT?: string;
  FLAGS: KVNamespace;
  STATE: KVNamespace;
  CLOUDFLARE_API_TOKEN: string;
  SLACK_WEBHOOK_URL: string;
}
