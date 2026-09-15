import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

export async function applyMigrations(db: D1Database): Promise<void> {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
}
