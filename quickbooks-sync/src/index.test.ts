import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('applies all four table migrations', async () => {
    for (const table of ['qb_oauth_tokens', 'qb_monday_map', 'qb_events', 'monday_events']) {
      const result = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?1"
      )
        .bind(table)
        .first();
      expect(result, `expected table "${table}" to exist`).not.toBeNull();
    }
  });
});
