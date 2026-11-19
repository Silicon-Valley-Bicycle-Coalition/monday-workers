import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1VerifiedEmailStore } from './verifiedEmails';

interface Row {
  person_item_id: string;
  first_verified_at: string;
  last_verified_at: string;
}

async function rows(emailHash: string): Promise<Row[]> {
  const result = await env.DB.prepare(
    'SELECT person_item_id, first_verified_at, last_verified_at FROM verified_emails WHERE email_hash = ?1 ORDER BY person_item_id'
  )
    .bind(emailHash)
    .all<Row>();
  return result.results;
}

describe('D1VerifiedEmailStore', () => {
  it('inserts with first and last verified both set to the time given', async () => {
    const store = new D1VerifiedEmailStore(env.DB);
    await store.recordVerified('ve-a', ['p1'], '2026-11-18T10:00:00.000Z');
    expect(await rows('ve-a')).toEqual([
      { person_item_id: 'p1', first_verified_at: '2026-11-18T10:00:00.000Z', last_verified_at: '2026-11-18T10:00:00.000Z' },
    ]);
  });

  it('keeps first_verified_at and moves last_verified_at on a later call', async () => {
    const store = new D1VerifiedEmailStore(env.DB);
    await store.recordVerified('ve-b', ['p1'], '2026-11-18T10:00:00.000Z');
    await store.recordVerified('ve-b', ['p1'], '2026-11-19T10:00:00.000Z');
    expect(await rows('ve-b')).toEqual([
      { person_item_id: 'p1', first_verified_at: '2026-11-18T10:00:00.000Z', last_verified_at: '2026-11-19T10:00:00.000Z' },
    ]);
  });

  it('writes one row per person id', async () => {
    const store = new D1VerifiedEmailStore(env.DB);
    await store.recordVerified('ve-c', ['p1', 'p2'], '2026-11-18T10:00:00.000Z');
    expect((await rows('ve-c')).map((r) => r.person_item_id)).toEqual(['p1', 'p2']);
  });

  it('does nothing for an empty id list', async () => {
    const store = new D1VerifiedEmailStore(env.DB);
    await store.recordVerified('ve-d', [], '2026-11-18T10:00:00.000Z');
    expect(await rows('ve-d')).toEqual([]);
  });

  it('verifiedFor returns `${emailHash}:${personId}` keys for the given people only', async () => {
    const store = new D1VerifiedEmailStore(env.DB);
    await store.recordVerified('vf-shared', ['vf-p1', 'vf-p2', 'vf-p3'], '2026-11-18T10:00:00.000Z');
    await store.recordVerified('vf-own', ['vf-p1'], '2026-11-18T10:00:00.000Z');
    await store.recordVerified('vf-other', ['vf-p3'], '2026-11-18T10:00:00.000Z');
    expect([...(await store.verifiedFor(['vf-p1', 'vf-p2']))].sort()).toEqual(['vf-own:vf-p1', 'vf-shared:vf-p1', 'vf-shared:vf-p2']);
  });

  it('verifiedFor an empty id list is an empty set', async () => {
    expect((await new D1VerifiedEmailStore(env.DB).verifiedFor([])).size).toBe(0);
  });
});
