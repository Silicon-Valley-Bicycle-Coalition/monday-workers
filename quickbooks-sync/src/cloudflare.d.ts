declare module 'cloudflare:test' {
  export interface D1Migration {
    name: string;
    content: string;
  }

  export function applyD1Migrations(
    db: D1Database,
    migrations: D1Migration[]
  ): Promise<void>;
}

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env;
}
