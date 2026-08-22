import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('applies the auth tables migration', async () => {
    const tokens = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='magic_link_tokens'"
    ).first();
    const sessions = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).first();
    const attempts = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'"
    ).first();
    expect(tokens).not.toBeNull();
    expect(sessions).not.toBeNull();
    expect(attempts).not.toBeNull();
  });
});
