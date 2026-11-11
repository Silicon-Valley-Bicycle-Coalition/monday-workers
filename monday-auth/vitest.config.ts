import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { TEST_ENC_KEY } from './test/enc-key.ts';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return defineProject({
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, TOKEN_ENC_KEY: TEST_ENC_KEY },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      passWithNoTests: true,
    },
  });
});
