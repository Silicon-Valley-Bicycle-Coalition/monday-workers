import { defineConfig } from 'vitest/config';

// No D1/queues here (unlike member-portal), so plain vitest is enough — routes are tested via
// Hono's app.request() with a hand-built fake Env, not the Cloudflare Workers runtime pool.
export default defineConfig({
  test: {},
});
