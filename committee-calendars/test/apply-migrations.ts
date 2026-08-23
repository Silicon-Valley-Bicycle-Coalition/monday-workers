import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// @cloudflare/vitest-plugin isolates storage per test *file*, not per test (see
// https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).
// Without this, D1 rows written by one `it` block are still visible to the next `it` block in the
// same file. Reset storage and reapply migrations after every test so each test starts from a
// clean, migrated database.
afterEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
