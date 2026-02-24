declare module "cloudflare:test" {
  interface ProvidedEnv {
    EVENTBRITE_ORG_ID: string;
    CACHE_TTL: string;
    CACHE_VERSION: string;
    EVENTBRITE_TOKEN: string;
  }
}
