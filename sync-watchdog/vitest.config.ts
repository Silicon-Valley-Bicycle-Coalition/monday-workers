import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig(
  defineProject({
    plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  }),
);
