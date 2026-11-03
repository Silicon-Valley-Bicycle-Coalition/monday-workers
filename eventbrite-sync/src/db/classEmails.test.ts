import { env } from 'cloudflare:workers';
import { beforeEach, describe, it, expect } from 'vitest';
import { D1ClassEmailStore } from './classEmails';

const T0 = '2026-11-03T00:00:00.000Z';
const T1 = '2026-11-03T00:05:00.000Z';
const T2 = '2026-11-03T00:10:00.000Z';

describe('D1ClassEmailStore', () => {
  let store: D1ClassEmailStore;
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM class_email_recipients');
    store = new D1ClassEmailStore(env.DB);
  });

  it('claim returns only newly claimed ids', async () => {
    expect(await store.claim('e1', 'reminder', ['r1', 'r2'], T0)).toEqual(['r1', 'r2']);
    expect(await store.claim('e1', 'reminder', ['r2', 'r3'], T1)).toEqual(['r3']);
  });

  it('claim of an empty list returns an empty list', async () => {
    expect(await store.claim('e1', 'reminder', [], T0)).toEqual([]);
  });

  it('a claim records claimed status and the claim time, with no resolution', async () => {
    await store.claim('e1', 'missed-you', ['r1'], T0);
    expect(await store.listByEvent('e1')).toEqual([
      { eventId: 'e1', kind: 'missed-you', registrationId: 'r1', status: 'claimed', claimedAt: T0, resolvedAt: null },
    ]);
  });

  it('kinds and events are independent', async () => {
    await store.claim('e1', 'reminder', ['r1'], T0);
    expect(await store.claim('e1', 'thank-you', ['r1'], T0)).toEqual(['r1']);
    expect(await store.claim('e2', 'reminder', ['r1'], T0)).toEqual(['r1']);
  });

  it('listByEvent returns only that event', async () => {
    await store.claim('e1', 'reminder', ['r1'], T0);
    await store.claim('e2', 'reminder', ['r2'], T0);
    expect((await store.listByEvent('e1')).map((r) => r.registrationId)).toEqual(['r1']);
  });

  it('resolve sets status and resolvedAt', async () => {
    await store.claim('e1', 'reminder', ['r1'], T0);
    await store.resolve('e1', 'reminder', 'r1', 'sent', T1);
    expect((await store.listByEvent('e1'))[0]).toMatchObject({ status: 'sent', resolvedAt: T1 });
  });

  it('resolve never downgrades sent', async () => {
    await store.claim('e1', 'reminder', ['r1'], T0);
    await store.resolve('e1', 'reminder', 'r1', 'sent', T1);
    await store.resolve('e1', 'reminder', 'r1', 'failed', T2);
    expect((await store.listByEvent('e1'))[0]!.status).toBe('sent');
  });

  it('release frees claimed and failed rows, but not sent ones', async () => {
    await store.claim('e1', 'reminder', ['r1', 'r2', 'r3'], T0);
    await store.resolve('e1', 'reminder', 'r2', 'failed', T1);
    await store.resolve('e1', 'reminder', 'r3', 'sent', T1);
    await store.release('e1', 'reminder', ['r1', 'r2', 'r3']);
    expect((await store.listByEvent('e1')).map((r) => r.registrationId)).toEqual(['r3']);
  });

  it('a released id can be claimed again', async () => {
    await store.claim('e1', 'reminder', ['r1'], T0);
    await store.release('e1', 'reminder', ['r1']);
    expect(await store.claim('e1', 'reminder', ['r1'], T1)).toEqual(['r1']);
  });

  it('concurrent claims never both win a row', async () => {
    const [a, b] = await Promise.all([
      store.claim('e1', 'reminder', ['r1', 'r2', 'r3'], T0),
      store.claim('e1', 'reminder', ['r2', 'r3', 'r4'], T0),
    ]);
    expect([...a, ...b].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});
