import { describe, it, expect, vi } from 'vitest';
import { createApp, WEBHOOK_DELAY_SECONDS } from './route';
import type { PendingStore } from '../db/pending';
import type { WriteMode } from '../flags';

const ON = async (): Promise<WriteMode> => 'on';

// Mirrors config.donationRollups.donationBoards, the way index.ts derives it.
const BOARD_IDS = new Set(['1', '18427756119']);

function fakePendingStore(overrides: Partial<PendingStore> = {}): PendingStore {
  return {
    upsertPending: vi.fn().mockResolvedValue(undefined),
    pruneFinished: vi.fn().mockResolvedValue(0),
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
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    const res = await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 1 } }, '');
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects the wrong secret too', async () => {
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc' }, '?secret=wrong');
    expect(res.status).toBe(401);
  });

  it('accepts the correct secret, including for the challenge handshake', async () => {
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc' }, '?secret=shh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });

  // Issue GL#27: an unset secret used to open the route to anyone. It now fails closed, like
  // funraise-sync and the custodian routes — no request is accepted, not even the handshake.
  it.each([[undefined], ['']])('fails closed when the configured secret is %j', async (webhookSecret) => {
    const send = vi.fn();
    const pendingStore = fakePendingStore();
    const app = createApp({ writeMode: ON, pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret });
    for (const query of ['', '?secret=', '?secret=anything']) {
      expect((await post(app, { challenge: 'abc' }, query)).status).toBe(401);
      expect((await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 1 } }, query)).status).toBe(401);
    }
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a secret that only shares a prefix with the configured one', async () => {
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    expect((await post(app, { challenge: 'abc' }, '?secret=sh')).status).toBe(401);
    expect((await post(app, { challenge: 'abc' }, '?secret=shhh')).status).toBe(401);
  });
});

describe('POST /webhooks/monday/donations', () => {
  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send: vi.fn() }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('upserts and enqueues a valid event, keyed on the donation item id', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ writeMode: ON, pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 555, boardId: 18427756119 } });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({ donationItemId: '555', donationBoardId: '18427756119' }),
    );
    expect(send).toHaveBeenCalledWith({ donationItemId: '555', donationBoardId: '18427756119' }, { delaySeconds: WEBHOOK_DELAY_SECONDS });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('555', 'queued');
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const send = vi.fn();
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    const res = await post(app, { event: { type: 'create_pulse' } }); // no pulseId
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws, so Monday redelivers', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createApp({ writeMode: ON, pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });

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
    const app = createApp({ writeMode: ON, pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 9, boardId: 99999 } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('99999') });
    expect(send).not.toHaveBeenCalled();
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
  });

  it('still enqueues events from every configured board', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    for (const boardId of [1, 18427756119]) {
      const res = await post(app, { event: { type: 'create_pulse', pulseId: 5, boardId } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('classification columns', () => {
  const IGNORED = new Set(['1:fs', '1:gs']);
  const app = (send = vi.fn()) => ({ send,
    app: createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: IGNORED, webhookSecret: 'shh' }) });

  it("acknowledges and drops the classify duty's own writes", async () => {
    const { app: a, send } = app();
    const res = await post(a, { event: { type: 'update_column_value', pulseId: 9, boardId: 1, columnId: 'fs' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('classification') });
    expect(send).not.toHaveBeenCalled();
  });

  it('still enqueues a real column change on the same board', async () => {
    const { app: a, send } = app();
    await post(a, { event: { type: 'update_column_value', pulseId: 9, boardId: 1, columnId: 'amount' } });
    expect(send).toHaveBeenCalledOnce();
  });

  it('still enqueues an item creation, which has no columnId', async () => {
    const { app: a, send } = app();
    await post(a, { event: { type: 'create_pulse', pulseId: 9, boardId: 1 } });
    expect(send).toHaveBeenCalledOnce();
  });

  it('matches per board — the same column id on another board is not ignored', async () => {
    const { app: a, send } = app();
    await post(a, { event: { type: 'update_column_value', pulseId: 9, boardId: 18427756119, columnId: 'fs' } });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('Event Registrations webhooks', () => {
  const REG = new Map([['7', new Set(['att', 'ev', 'atd', 'role', 'hrs'])]]);
  function regApp(send = vi.fn(), pendingStore = fakePendingStore()) {
    return { app: createApp({ writeMode: ON, pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: REG, ignoredColumnIds: new Set(), webhookSecret: 'shh' }), send, pendingStore };
  }
  it('enqueues a registration message for create_pulse and records kind on the pending row', async () => {
    const { app, send, pendingStore } = regApp();
    const res = await post(app, { event: { type: 'create_pulse', pulseId: 41, boardId: 7 } });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ kind: 'registration', donationItemId: '41', donationBoardId: '7' }, { delaySeconds: WEBHOOK_DELAY_SECONDS });
    expect(pendingStore.upsertPending).toHaveBeenCalledWith(expect.objectContaining({ donationItemId: '41', donationBoardId: '7', kind: 'registration' }));
  });
  it('enqueues for a change to an accepted column, item deletion and item restore', async () => {
    const { app, send } = regApp();
    await post(app, { event: { type: 'update_column_value', pulseId: 41, boardId: 7, columnId: 'atd' } });
    await post(app, { event: { type: 'delete_pulse', pulseId: 41, boardId: 7 } });
    await post(app, { event: { type: 'restore_pulse', pulseId: 41, boardId: 7 } });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('ignores a change to any other column on a registration board', async () => {
    const { app, send } = regApp();
    const res = await post(app, { event: { type: 'update_column_value', pulseId: 41, boardId: 7, columnId: 'notes' } });
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('notes') });
    expect(send).not.toHaveBeenCalled();
  });
  it('still ignores boards in neither set', async () => {
    const { app, send } = regApp();
    const res = await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 999 } });
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.any(String) });
    expect(send).not.toHaveBeenCalled();
  });
});

// The write switch (spec 2026-10-26): ingest stays live in every mode — the pending row and the
// enqueue are this Worker's own bookkeeping — but a message enqueued under `off` is stamped, so
// the consumer dry-runs it even if writes are back `on` by the time it's consumed.
describe('write switch', () => {
  function switchApp(mode: WriteMode, send = vi.fn().mockResolvedValue(undefined), pendingStore = fakePendingStore()) {
    const writeMode = vi.fn(async () => mode);
    return { app: createApp({ writeMode, pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' }), send, pendingStore, writeMode };
  }

  it('stamps the message dropped under off, and still records and enqueues it', async () => {
    const { app, send, pendingStore } = switchApp('off');
    const res = await post(app, { event: { type: 'create_pulse', pulseId: 5, boardId: 1 } });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ donationItemId: '5', donationBoardId: '1', writeStamp: 'dropped' }, { delaySeconds: WEBHOOK_DELAY_SECONDS });
    expect(pendingStore.upsertPending).toHaveBeenCalledOnce();
    // Recorded 'dropped', not 'queued': the nightly requeue must never re-send it as live work.
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('5', 'dropped');
    expect(pendingStore.updateStatus).not.toHaveBeenCalledWith('5', 'queued');
  });

  it.each([['on'], ['hold']] as const)('records the row queued under %s', async (mode) => {
    const { app, pendingStore } = switchApp(mode);
    await post(app, { event: { type: 'create_pulse', pulseId: 5, boardId: 1 } });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('5', 'queued');
  });

  it.each([['on'], ['hold'], ['unknown']] as const)('leaves the message unstamped under %s', async (mode) => {
    const { app, send } = switchApp(mode);
    await post(app, { event: { type: 'create_pulse', pulseId: 5, boardId: 1 } });
    expect(send).toHaveBeenCalledWith({ donationItemId: '5', donationBoardId: '1' }, { delaySeconds: WEBHOOK_DELAY_SECONDS });
  });

  it('reads the mode only for a delivery it enqueues — not for the handshake or an ignored board', async () => {
    const { app, writeMode } = switchApp('off');
    await post(app, { challenge: 'abc' });
    await post(app, { event: { type: 'create_pulse', pulseId: 5, boardId: 999 } });
    expect(writeMode).not.toHaveBeenCalled();
  });
});

describe('Affiliations webhooks', () => {
  const AFF = new Map([['555', new Set(['br_p', 'br_o', 'st', 'pr'])]]);
  function affApp(send = vi.fn(), pendingStore = fakePendingStore()) {
    return { app: createApp({ writeMode: ON, pendingStore, queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), affiliationBoards: AFF, ignoredColumnIds: new Set(), webhookSecret: 'shh' }), send, pendingStore };
  }
  it('enqueues an affiliation message for a change to a watched column and records kind on the pending row', async () => {
    const { app, send, pendingStore } = affApp();
    const res = await post(app, { event: { type: 'update_column_value', pulseId: 41, boardId: 555, columnId: 'br_o' } });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ kind: 'affiliation', donationItemId: '41', donationBoardId: '555' }, { delaySeconds: WEBHOOK_DELAY_SECONDS });
    expect(pendingStore.upsertPending).toHaveBeenCalledWith(expect.objectContaining({ donationItemId: '41', donationBoardId: '555', kind: 'affiliation' }));
  });
  it('enqueues for a new item', async () => {
    const { app, send } = affApp();
    await post(app, { event: { type: 'create_pulse', pulseId: 41, boardId: 555 } });
    expect(send).toHaveBeenCalledOnce();
  });
  it('enqueues for a deleted or restored item, which name it as itemId', async () => {
    for (const type of ['delete_pulse', 'restore_pulse']) {
      const { app, send } = affApp();
      await post(app, { event: { type, itemId: 41, boardId: 555 } });
      expect(send).toHaveBeenCalledWith({ kind: 'affiliation', donationItemId: '41', donationBoardId: '555' }, { delaySeconds: WEBHOOK_DELAY_SECONDS });
    }
  });
  it('ignores any other column, including the attributed totals this Worker writes to the same board', async () => {
    const { app, send } = affApp();
    const res = await post(app, { event: { type: 'update_column_value', pulseId: 41, boardId: 555, columnId: 'n_ag' } });
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('n_ag') });
    expect(send).not.toHaveBeenCalled();
  });
  it('still ignores an unconfigured board when employer sync is off', async () => {
    const send = vi.fn();
    const app = createApp({ writeMode: ON, pendingStore: fakePendingStore(), queue: { send }, donationBoardIds: BOARD_IDS, registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh' });
    await post(app, { event: { type: 'create_pulse', pulseId: 41, boardId: 555 } });
    expect(send).not.toHaveBeenCalled();
  });
});
