import { defineConfig } from 'vitest/config';

// No D1/queues/KV here, so plain vitest is enough — the Monday client and the EMAIL binding are
// faked in the tests, not run in the Workers runtime pool.
export default defineConfig({
  test: {},
});
