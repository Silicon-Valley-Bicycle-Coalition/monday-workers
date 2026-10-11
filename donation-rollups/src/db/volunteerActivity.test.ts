import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1VolunteerActivityStore, type VolunteerActivityRow } from './volunteerActivity';

const NOW = '2026-11-06T12:00:00Z';
const row = (over: Partial<VolunteerActivityRow> = {}): VolunteerActivityRow => ({
  registrationItemId: `r-${Math.random().toString(36).slice(2)}`, boardId: 'er',
  ownerItemId: 'p1', ownerBoardId: 'people', activityDateISO: '2027-03-14', hours: null,
  qualifies: true, source: 'webhook', ...over,
});

describe('D1VolunteerActivityStore', () => {
  it('upsert then forOwner reads back qualifying rows, nulls preserved', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    const r = row({ ownerItemId: 'owner-a', hours: null });
    expect(await store.upsert(r, NOW)).toEqual({ previousOwner: null });
    expect(await store.forOwner('owner-a')).toEqual([r]);
  });

  it('upsertMany writes rows across chunks and re-running updates them in place', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    const rows = Array.from({ length: 120 }, (_, i) => row({ registrationItemId: `many-${i}`, ownerItemId: 'owner-many', activityDateISO: `2027-01-${String(1 + (i % 28)).padStart(2, '0')}` }));
    await store.upsertMany(rows, NOW);
    expect(await store.forOwner('owner-many')).toHaveLength(120);
    await store.upsertMany(rows.map((r, i) => ({ ...r, qualifies: i % 2 === 0 })), NOW);
    expect(await store.forOwner('owner-many')).toHaveLength(60);
  });

  it('forOwner omits non-qualifying rows', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    await store.upsert(row({ ownerItemId: 'owner-b', qualifies: false }), NOW);
    await store.upsert(row({ ownerItemId: 'owner-b', hours: 2, qualifies: true }), NOW);
    expect((await store.forOwner('owner-b')).map((r) => r.hours)).toEqual([2]);
  });

  it('upsert reports the previous owner when the Attendee link moved, and null when unchanged', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    const r = row({ ownerItemId: 'owner-c', ownerBoardId: 'people' });
    await store.upsert(r, NOW);
    expect(await store.upsert({ ...r, ownerItemId: 'owner-d' }, NOW))
      .toEqual({ previousOwner: { ownerItemId: 'owner-c', ownerBoardId: 'people' } });
    expect(await store.upsert({ ...r, ownerItemId: 'owner-d' }, NOW)).toEqual({ previousOwner: null });
    expect(await store.forOwner('owner-c')).toEqual([]);
  });

  it('markRemoved flips qualifies off and returns the owner it had; unknown ids return null', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    const r = row({ ownerItemId: 'owner-e' });
    await store.upsert(r, NOW);
    expect(await store.markRemoved(r.registrationItemId, NOW)).toEqual({ ownerItemId: 'owner-e', ownerBoardId: 'people' });
    expect(await store.forOwner('owner-e')).toEqual([]);
    expect(await store.markRemoved('nope', NOW)).toBeNull();
  });

  it('ownersWithActivity lists distinct qualifying owners after a cursor, ordered', async () => {
    const store = new D1VolunteerActivityStore(env.DB);
    for (const o of ['z-owner-2', 'z-owner-1', 'z-owner-2']) await store.upsert(row({ ownerItemId: o }), NOW);
    await store.upsert(row({ ownerItemId: 'z-owner-3', qualifies: false }), NOW);
    expect(await store.ownersWithActivity('z-', 10)).toEqual([
      { ownerItemId: 'z-owner-1', ownerBoardId: 'people' }, { ownerItemId: 'z-owner-2', ownerBoardId: 'people' }]);
    expect(await store.ownersWithActivity('z-owner-1', 1)).toEqual([{ ownerItemId: 'z-owner-2', ownerBoardId: 'people' }]);
  });
});
