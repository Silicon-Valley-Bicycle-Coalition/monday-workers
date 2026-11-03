import { defineConfig } from 'vitest/config';

// No D1/queues/KV in the tests: the Monday client and bindings are faked, not run in the Workers
// runtime pool, so plain vitest is enough.
export default defineConfig({
  test: {},
});
