import { describe, it, expect, vi } from 'vitest';
import { createApp } from './route';
import type { PendingStore } from '../db/pending';

// Mirrors config.donationRollups.donationBoards, the way index.ts derives it.
const BOARD_IDS = new Set(['1', '18427756119']);

function fakePendingStore(overrides: Partial<PendingStore> = {}): PendingStore {
  return {
    upsertPending: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockResolvedValue(null),
    listStuck: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown, query = '?secret=shh') {
  return app.request(`/webhooks/monday/donations${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('webhook secret', () => {
  it('rejects a request missing the configured secret with 401, before touching the body', async () => {
    const send = vi.fn();
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });
    const res = await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 1 } }, '');
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects the wrong secret too', async () => {
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc' }, '?secret=wrong');
    expect(res.status).toBe(401);
  });

  it('accepts the correct secret, including for the challenge handshake', async () => {
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc' }, '?secret=shh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });

  // Issue #27: an unset secret used to open the route to anyone. It now fails closed, like
  // funraise-sync and the custodian routes — no request is accepted, not even the handshake.
  it.each([[undefined], ['']])('fails closed when the configured secret is %j', async (webhookSecret) => {
    const send = vi.fn();
    const pendingStore = fakePendingStore();
    const app = createApp({ pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, webhookSecret });
    for (const query of ['', '?secret=', '?secret=anything']) {
      expect((await post(app, { challenge: 'abc' }, query)).status).toBe(401);
      expect((await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 1 } }, query)).status).toBe(401);
    }
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a secret that only shares a prefix with the configured one', async () => {
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });
    expect((await post(app, { challenge: 'abc' }, '?secret=sh')).status).toBe(401);
    expect((await post(app, { challenge: 'abc' }, '?secret=shhh')).status).toBe(401);
  });
});

describe('POST /webhooks/monday/donations', () => {
  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('upserts and enqueues a valid event, keyed on the donation item id', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 555, boardId: 18427756119 } });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({ donationItemId: '555', donationBoardId: '18427756119' }),
    );
    expect(send).toHaveBeenCalledWith({ donationItemId: '555', donationBoardId: '18427756119' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('555', 'queued');
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const send = vi.fn();
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });
    const res = await post(app, { event: { type: 'create_pulse' } }); // no pulseId
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws, so Monday redelivers', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createApp({ pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 1 } });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'failed', { error: 'queue down' });
  });
});

describe('board allowlist', () => {
  it('acknowledges but ignores an event from a board outside config.donationBoards — no enqueue, no D1 row', async () => {
    // e.g. the superseded sandbox board's still-live webhook subscription: a permanent
    // config mismatch, not a transient failure — 200 so Monday neither retries nor
    // disables the subscription, and nothing enters the queue to churn toward the DLQ.
    const pendingStore = fakePendingStore();
    const send = vi.fn();
    const app = createApp({ pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 9, boardId: 99999 } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('99999') });
    expect(send).not.toHaveBeenCalled();
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
  });

  it('still enqueues events from every configured board', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, webhookSecret: 'shh' });
    for (const boardId of [1, 18427756119]) {
      const res = await post(app, { event: { type: 'create_pulse', pulseId: 5, boardId } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(send).toHaveBeenCalledTimes(2);
  });
});
