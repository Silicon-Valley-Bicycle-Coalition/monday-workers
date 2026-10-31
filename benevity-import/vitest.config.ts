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
          bindings: { TEST_MIGRATIONS: migrations },
          // wrangler.jsonc binds MONDAY_AUTH to the monday-auth Worker, which isn't running
          // here. Tests that need a token pass their own MONDAY_AUTH or MONDAY_API_TOKEN in env;
          // this stand-in only satisfies the binding so the test runner can start.
          serviceBindings: { MONDAY_AUTH: () => new Response('monday-auth is not running in tests', { status: 503 }) },
        },
      }),
    ],
  });
});
