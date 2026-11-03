import { defineConfig } from 'vitest/config';

// No D1/R2 pool here: the Monday client, D1 and R2 are faked in the tests, not run in the Workers
// runtime pool. public/js tests cover the page's pure helpers.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'config/**/*.test.ts', 'public/js/**/*.test.js'],
  },
});
