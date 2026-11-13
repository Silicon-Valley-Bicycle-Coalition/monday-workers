import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig, defineProject } from 'vitest/config';

export default defineConfig(
  defineProject({
    // scripts/*.test.mjs are node:test files, run by `npm run test:scripts`.
    test: { exclude: [...configDefaults.exclude, 'scripts/**'] },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // wrangler.jsonc binds MONDAY_AUTH to the monday-auth Worker, which isn't running
          // here. Tests that need a token pass their own MONDAY_AUTH in env; this stand-in only
          // satisfies the binding so the test runner can start.
          serviceBindings: { MONDAY_AUTH: () => new Response('monday-auth is not running in tests', { status: 503 }) },
        },
      }),
    ],
  }),
);
