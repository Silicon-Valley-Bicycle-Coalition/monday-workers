import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { D1MembershipBaselineStore, type BaselineRow } from './membershipBaseline';

const row = (over: Partial<BaselineRow> = {}): BaselineRow => ({
  ownerItemId: `o-${Math.random().toString(36).slice(2)}`, ownerBoardId: 'b1',
  since: '2015-01-01', until: '2026-03-01', tier: 'member', capturedAt: '2026-10-05T00:00:00Z', ...over,
});

describe('D1MembershipBaselineStore', () => {
  it('get returns null for an unknown owner', async () => {
    expect(await new D1MembershipBaselineStore(env.DB).get('nobody')).toBeNull();
  });

  it('captureIfAbsent inserts and get reads it back, nulls preserved', async () => {
    const store = new D1MembershipBaselineStore(env.DB);
    const r = row({ until: null, tier: 'lifetime' });
    expect(await store.captureIfAbsent(r)).toEqual(r);
    expect(await store.get(r.ownerItemId)).toEqual(r);
  });

  it('captureIfAbsent never overwrites — the first capture wins', async () => {
    const store = new D1MembershipBaselineStore(env.DB);
    const first = row();
    await store.captureIfAbsent(first);
    const second = { ...first, since: '1999-01-01', until: '2030-01-01', capturedAt: '2026-11-01T00:00:00Z' };
    expect(await store.captureIfAbsent(second)).toEqual(first);
    expect(await store.get(first.ownerItemId)).toEqual(first);
  });

  it('a never-member baseline is all nulls', async () => {
    const store = new D1MembershipBaselineStore(env.DB);
    const r = row({ since: null, until: null, tier: null });
    await store.captureIfAbsent(r);
    expect(await store.get(r.ownerItemId)).toEqual(r);
  });
});
