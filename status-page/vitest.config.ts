import { defineConfig } from 'vitest/config';

// No Workers runtime pool: KV and fetch are faked in the tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'config/**/*.test.ts'],
  },
});
