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
          // wrangler.jsonc binds MONDAY_AUTH to the monday-auth Worker, which isn't running
          // here. Tests that need a token pass their own MONDAY_AUTH or MONDAY_API_TOKEN in env;
          // this stand-in only satisfies the binding so the test runner can start. EMPLOYER_ANSWERS
          // (impact-attribution's RPC) likewise: tests of the hand-over pass their own sink.
          serviceBindings: {
            MONDAY_AUTH: () => new Response('monday-auth is not running in tests', { status: 503 }),
            EMPLOYER_ANSWERS: () => new Response('impact-attribution is not running in tests', { status: 503 }),
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  });
});
