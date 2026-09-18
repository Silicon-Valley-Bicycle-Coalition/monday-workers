import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1AffiliationsStore } from './affiliations';

beforeEach(async () => { await env.DB.prepare('DELETE FROM affiliations').run(); });

describe('D1AffiliationsStore', () => {
  it('upserts, reads back, and lists by person', async () => {
    const store = new D1AffiliationsStore(env.DB);
    await store.upsert({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Acme' }, '2026-01-01T00:00:00Z');
    await store.upsert({ affiliationItemId: 'af-2', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Beta' }, '2026-01-01T00:00:00Z');
    expect(await store.get('af-1')).toEqual({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Acme' });
    expect(await store.get('af-x')).toBeNull();
    expect((await store.forPerson('p-1')).map((a) => a.affiliationItemId).sort()).toEqual(['af-1', 'af-2']);
  });
  it('a re-point moves the affiliation to the new person', async () => {
    const store = new D1AffiliationsStore(env.DB);
    await store.upsert({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: 'b1', name: 'Ada @ Acme' }, '2026-01-01T00:00:00Z');
    await store.upsert({ affiliationItemId: 'af-1', personItemId: 'p-2', personBoardId: 'b2', name: 'Ada @ Acme' }, '2026-01-02T00:00:00Z');
    expect((await store.get('af-1'))?.personItemId).toBe('p-2');
    expect(await store.forPerson('p-1')).toEqual([]);
  });
  it('bulkUpsert writes in batches and returns the count', async () => {
    const store = new D1AffiliationsStore(env.DB);
    const rows = Array.from({ length: 250 }, (_, i) => ({ affiliationItemId: `af-${i}`, personItemId: `p-${i % 7}`,
      personBoardId: 'b1', name: `P${i} @ O`, updatedAt: '2026-01-01T00:00:00Z' }));
    expect(await store.bulkUpsert(rows)).toBe(250);
    expect((await store.forPerson('p-0')).length).toBe(36);
  });
});
