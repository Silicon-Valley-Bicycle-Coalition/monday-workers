import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1OrgStatementSendStore } from './orgStatementSends';

const AT = '2027-01-15T10:00:00.000Z';

describe('D1OrgStatementSendStore', () => {
  it('creates a queued row and reads it back by id and by key', async () => {
    const store = new D1OrgStatementSendStore(env.DB);
    const id = await store.createQueued({ orgItemId: 'org-1', affiliationItemId: 'aff-1', year: 2026, createdAt: AT });
    const row = { id, orgItemId: 'org-1', affiliationItemId: 'aff-1', year: 2026, status: 'queued', createdAt: AT, sentAt: null };
    expect(await store.getById(id)).toEqual(row);
    expect(await store.findByKey('org-1', 'aff-1', 2026)).toEqual(row);
    expect(await store.findByKey('org-1', 'aff-1', 2025)).toBeNull();
    expect(await store.findByKey('org-1', 'aff-2', 2026)).toBeNull();
    expect(await store.getById(999_999)).toBeNull();
  });

  it('rejects a second row for the same organization, Affiliation and year', async () => {
    const store = new D1OrgStatementSendStore(env.DB);
    await store.createQueued({ orgItemId: 'org-2', affiliationItemId: 'aff-1', year: 2026, createdAt: AT });
    await expect(store.createQueued({ orgItemId: 'org-2', affiliationItemId: 'aff-1', year: 2026, createdAt: AT })).rejects.toThrow();
    // Another rep of the same organization is its own row.
    await expect(store.createQueued({ orgItemId: 'org-2', affiliationItemId: 'aff-2', year: 2026, createdAt: AT })).resolves.toEqual(expect.any(Number));
  });

  it('claims a queued row exactly once, and releases only a claim', async () => {
    const store = new D1OrgStatementSendStore(env.DB);
    const id = await store.createQueued({ orgItemId: 'org-3', affiliationItemId: 'aff-1', year: 2026, createdAt: AT });

    expect(await store.claimForSending(id, AT)).toBe(true);
    expect(await store.claimForSending(id, AT)).toBe(false);
    expect((await store.getById(id))?.status).toBe('sending');

    await store.releaseClaim(id);
    expect((await store.getById(id))?.status).toBe('queued');

    await store.claimForSending(id, AT);
    await store.markSent(id, '2027-01-15T10:05:00.000Z');
    await store.releaseClaim(id);
    expect(await store.getById(id)).toMatchObject({ status: 'sent', sentAt: '2027-01-15T10:05:00.000Z' });
  });

  it('marks a row skipped and requeues it', async () => {
    const store = new D1OrgStatementSendStore(env.DB);
    const id = await store.createQueued({ orgItemId: 'org-4', affiliationItemId: 'aff-1', year: 2026, createdAt: AT });
    await store.markSkipped(id, AT);
    expect((await store.getById(id))?.status).toBe('skipped');
    await store.requeue(id, AT);
    expect((await store.getById(id))?.status).toBe('queued');
  });

  it('lists the organization:Affiliation keys with a row for a year, any status', async () => {
    const store = new D1OrgStatementSendStore(env.DB);
    await store.createQueued({ orgItemId: 'org-5', affiliationItemId: 'aff-a', year: 2030, createdAt: AT });
    const skipped = await store.createQueued({ orgItemId: 'org-5', affiliationItemId: 'aff-b', year: 2030, createdAt: AT });
    await store.markSkipped(skipped, AT);
    await store.createQueued({ orgItemId: 'org-5', affiliationItemId: 'aff-c', year: 2029, createdAt: AT });

    expect([...(await store.listKeysForYear(2030))].sort()).toEqual(['org-5:aff-a', 'org-5:aff-b']);
  });
});
