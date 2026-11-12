import { defineConfig } from 'vitest/config';

// Plain vitest, not the Cloudflare Workers runtime pool: routes are tested via Hono's
// app.request() with a hand-built fake Env, and the one D1 query (src/sendGuard.ts) runs against
// Node's built-in SQLite in sendGuard.test.ts.
export default defineConfig({
  test: {},
});
