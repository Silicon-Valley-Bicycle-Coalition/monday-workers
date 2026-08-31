import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return defineProject({
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Both webhooks fail closed without their shared secret; give the
            // worker-entry-point tests known values to authenticate with.
            MONDAY_WEBHOOK_SECRET: 'test-monday-webhook-secret',
            MAILCHIMP_WEBHOOK_SECRET: 'test-mailchimp-webhook-secret',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  });
});
