import { describe, it, expect, vi } from 'vitest';
import { createOutboundApp } from './outboundRoute';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { Config, OutboundSyncMessage } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: 111, campaignsBoardId: 999, historical: null, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
    doNotSolicit: 'dns', dnsReasonStatus: 'dnsStatus', nearby: null,
  } },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never, interestCategoryIds: ['cat1'], journeyInterests: null, renewalDue: null, nearbyTagPrefix: 'Near: ' },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active', dnsConfirmedValue: 'Confirmed',
  consent: { enabled: false, maxChangesPerRun: 500, boards: [] },
  journeyLog: null,
  profileLinks: null,
};

const SECRET = 'test-webhook-secret';

function fakePendingStore(overrides: Partial<PendingOutboundStore> = {}): PendingOutboundStore {
  return {
    upsertPending: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    lastSyncStartedAt: vi.fn().mockResolvedValue(null),
    recordSyncStart: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function post(app: ReturnType<typeof createOutboundApp>, body: unknown, query = `?secret=${SECRET}`) {
  return app.request(`/webhooks/monday/donors${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('webhook secret', () => {
  it('rejects a request missing the secret with 401 and enqueues nothing', async () => {
    const send = vi.fn();
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });
    const res = await post(app, { event: { pulseId: 1 } }, '');
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong secret with 401 and enqueues nothing', async () => {
    const send = vi.fn();
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });
    const res = await post(app, { event: { pulseId: 1 } }, '?secret=wrong');
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed when the secret binding is unset or empty', async () => {
    // An undeployed/forgotten webhookSecret must reject everything, never disable the
    // check (no fail-open `deps.webhookSecret &&` shape).
    for (const missingSecret of [undefined, ''] as const) {
      const send = vi.fn();
      const app = createOutboundApp({
        pendingStore: fakePendingStore(),
        queue: { send },
        webhookSecret: missingSecret as unknown as string,
        writeMode: async () => 'on',
        config: CONFIG,
      });
      const res = await post(app, { event: { pulseId: 1 } }, `?secret=${missingSecret ?? ''}`);
      expect(res.status, `secret binding ${JSON.stringify(missingSecret)}`).toBe(401);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('does not echo the challenge handshake without the correct secret', async () => {
    // The secret is part of the URL Monday registers, so the one-time challenge arrives
    // with it too — an unauthenticated challenge is an attacker probing the endpoint.
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });
    const res = await post(app, { challenge: 'abc' }, '?secret=wrong');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('abc');
  });

  it('accepts the correct secret, including for the challenge handshake', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });
    const res = await post(app, { challenge: 'abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });
});

describe('POST /webhooks/monday/donors', () => {
  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('upserts and enqueues a valid event, keyed on the donor item id', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    const res = await post(app, { event: { pulseId: 555 } });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith('555', expect.any(String));
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('555', 'queued');
  });

  it('skips and does not enqueue a change_column_value event for the mailchimpCampaigns column (self-inflicted, avoids feedback loop)', async () => {
    const send = vi.fn();
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1, columnId: 'mc' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(send).not.toHaveBeenCalled();
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
  });

  it('skips a change to a column the sync never reads, such as a Location backfill', async () => {
    const send = vi.fn();
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1, columnId: 'location_xyz' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(send).not.toHaveBeenCalled();
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
  });

  it('still enqueues a change_column_value event for a column the sync reads', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1, columnId: 's' } });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
  });

  it('carries the previous address when the Email column changed, so the consumer can rename the member', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    await post(app, { event: { type: 'update_column_value', pulseId: 555, columnId: 'e', previousValue: { email: 'old@b.com', text: 'old@b.com' } } });

    expect(send).toHaveBeenCalledWith({ donorItemId: '555', previousEmail: 'old@b.com' });
  });

  it('does not carry a previous email-shaped value from any column but the configured Email column', async () => {
    // e.g. a Household Email edit: renaming the member after it would move the wrong address.
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    // Household Email itself isn't read by the sync, so it's skipped outright; the guard still
    // matters for any column the sync does read.
    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, columnId: 'household', previousValue: { email: 'old@b.com' } } });
    expect(await res.json()).toEqual({ ok: true, skipped: true });

    await post(app, { event: { type: 'update_column_value', pulseId: 555, columnId: 's', previousValue: { email: 'old@b.com' } } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
  });

  it('still enqueues a create_pulse event (no columnId at all)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 555, boardId: 1 } });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const send = vi.fn();
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });
    const res = await post(app, { event: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws, so Monday redelivers', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: SECRET, config: CONFIG, writeMode: async () => 'on' });

    const res = await post(app, { event: { pulseId: 1 } });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'failed', 'queue down');
  });
});

describe('the People (Historical) board', () => {
  const HISTORICAL_CONFIG: Config = { ...CONFIG, monday: { ...CONFIG.monday, historical: { boardId: 222, columns: {
    membershipStatus: 'h-s', membershipTier: 'h-t', memberSince: 'h-ms', memberUntil: 'h-mu', addr1: 'h-a1', city: 'h-c',
    state: null, zip: 'h-z', email: 'h-e', totalGiven: 'h-g', doNotSolicit: 'h-dns', dnsReasonStatus: 'h-dnsStatus', nearby: null,
  } } } };
  const appFor = (send: (message: OutboundSyncMessage) => Promise<void>) =>
    createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: SECRET, config: HISTORICAL_CONFIG, writeMode: async () => 'on' });

  it('enqueues a change to a column the sync reads on that board', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await post(appFor(send), { event: { type: 'update_column_value', pulseId: 555, boardId: 222, columnId: 'h-s' } });
    expect(await res.json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
  });

  it('skips a column on that board the sync does not read, even if People uses the id', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await post(appFor(send), { event: { type: 'update_column_value', pulseId: 555, boardId: 222, columnId: 's' } });
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('carries the old address from that board\'s own Email column', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await post(appFor(send), { event: { type: 'update_column_value', pulseId: 555, boardId: 222, columnId: 'h-e', previousValue: { email: 'old@b.com' } } });
    expect(send).toHaveBeenCalledWith({ donorItemId: '555', previousEmail: 'old@b.com' });
  });

  it('reads a board id Monday sends as a string', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await post(appFor(send), { event: { type: 'update_column_value', pulseId: 555, boardId: '222', columnId: 'h-s' } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still reads the People columns for a People event', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await post(appFor(send), { event: { type: 'update_column_value', pulseId: 555, boardId: 111, columnId: 's' } });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
