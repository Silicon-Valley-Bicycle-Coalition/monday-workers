import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is isolated per test file, not per test, so reset between every `it`.
afterEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
