import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import callerFixture from '../../test/fixtures/caller_call_element_completed.json';
import smsSentFixture from '../../test/fixtures/sms_sent.json';
import smsReceivedFixture from '../../test/fixtures/sms_received.json';
import { createApp, WEBHOOK_PATH } from './route';
import { hmacHex } from './signature';
import { D1EventStore, type PhoneQueueMessage } from '../db/events';
import type { WriteMode } from '../flags';
import { testConfig } from '../test/testConfig';

const SECRET = 'test-secret';
const NOW = Date.parse('2026-11-19T21:00:00Z');

let sent: PhoneQueueMessage[];
let mode: WriteMode;
let sendFails: boolean;

function app(config = testConfig()) {
  return createApp({
    eventStore: new D1EventStore(env.DB),
    config,
    queue: {
      sendBatch: async (messages) => {
        if (sendFails) throw new Error('queue unavailable');
        sent.push(...messages);
      },
    },
    webhookSecret: SECRET,
    writeMode: async () => mode,
    now: () => NOW,
  });
}

async function deliver(body: unknown, { secret = SECRET, ts = String(NOW / 1000), config = testConfig() } = {}) {
  const raw = JSON.stringify(body);
  const signature = `v0=${await hmacHex(secret, `v0:${ts}:${raw}`)}`;
  return app(config).request(WEBHOOK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zm-signature': signature, 'x-zm-request-timestamp': ts },
    body: raw,
  });
}

const rows = () => env.DB.prepare('SELECT * FROM phone_events ORDER BY event_id').all<Record<string, unknown>>().then((r) => r.results);

beforeEach(async () => {
  sent = [];
  mode = 'on';
  sendFails = false;
  await env.DB.exec('DELETE FROM phone_events');
});

describe('POST /webhooks/zoom: authentication', () => {
  it('answers endpoint.url_validation with the HMAC of plainToken', async () => {
    const res = await deliver({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plainToken: 'abc123', encryptedToken: await hmacHex(SECRET, 'abc123') });
  });

  it('refuses an unsigned url_validation (it would be an HMAC oracle)', async () => {
    const res = await app().request(WEBHOOK_PATH, {
      method: 'POST',
      body: JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } }),
    });
    expect(res.status).toBe(401);
  });

  it('401s a wrong signature or a stale timestamp, storing nothing', async () => {
    expect((await deliver(callerFixture, { secret: 'wrong' })).status).toBe(401);
    expect((await deliver(callerFixture, { ts: String(NOW / 1000 - 600) })).status).toBe(401);
    expect(await rows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('fails closed when the secret is unset', async () => {
    const unset = createApp({
      eventStore: new D1EventStore(env.DB),
      config: testConfig(),
      queue: { sendBatch: async () => {} },
      webhookSecret: undefined,
      writeMode: async () => 'on',
      now: () => NOW,
    });
    const raw = JSON.stringify(callerFixture);
    const ts = String(NOW / 1000);
    const res = await unset.request(WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-zm-signature': `v0=${await hmacHex('anything', `v0:${ts}:${raw}`)}`, 'x-zm-request-timestamp': ts },
      body: raw,
    });
    expect(res.status).toBe(401);
  });

  it('400s a signed body that is not JSON', async () => {
    const ts = String(NOW / 1000);
    const res = await app().request(WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-zm-signature': `v0=${await hmacHex(SECRET, `v0:${ts}:not json`)}`, 'x-zm-request-timestamp': ts },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /webhooks/zoom: ingest', () => {
  it('stores a call as pending, enqueues its key only, and marks it enqueued', async () => {
    const res = await deliver(callerFixture);
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ eventId: 'ce_out_1' }]);
    const [row] = await rows();
    expect(row).toMatchObject({
      event_id: 'ce_out_1',
      kind: 'call',
      call_id: 'call_out_1',
      zoom_user_id: 'user_ann',
      external_e164: '+14085550123',
      direction: 'outbound',
      result: 'answered',
      talk_seconds: 725,
      status: 'pending',
      attempts: 0,
      enqueued_at: '2026-11-19T21:00:00.000Z',
    });
  });

  it('dedupes a redelivery once the first copy was enqueued', async () => {
    await deliver(smsSentFixture);
    await deliver(smsSentFixture);
    expect(sent).toEqual([{ eventId: 'msg_out_1' }]);
    expect(await rows()).toHaveLength(1);
  });

  it('500s when the enqueue fails, and the redelivery enqueues the stranded row', async () => {
    sendFails = true;
    expect((await deliver(smsSentFixture)).status).toBe(500);
    expect((await rows())[0]).toMatchObject({ enqueued_at: null });
    sendFails = false;
    expect((await deliver(smsSentFixture)).status).toBe(200);
    expect(sent).toEqual([{ eventId: 'msg_out_1' }]);
    expect((await rows())[0]!.enqueued_at).not.toBeNull();
  });

  it('stamps messages dropped under writes off; hold enqueues them live', async () => {
    mode = 'off';
    await deliver(smsSentFixture);
    mode = 'hold';
    await deliver(smsReceivedFixture);
    expect(sent).toEqual([{ eventId: 'msg_out_1', writeStamp: 'dropped' }, { eventId: 'msg_in_1' }]);
  });

  it('stores nothing for a filtered event', async () => {
    const internal = JSON.parse(JSON.stringify(callerFixture));
    internal.payload.object.call_elements[0].connect_type = 'internal';
    expect((await deliver(internal)).status).toBe(200);
    expect((await deliver(smsSentFixture, { config: testConfig({ excludeUsers: ['user_ann'] }) })).status).toBe(200);
    expect(await rows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('ignores another Zoom account and unsubscribed events with a 200', async () => {
    const other = { ...smsSentFixture, payload: { ...smsSentFixture.payload, account_id: 'acct_other' } };
    expect((await deliver(other)).status).toBe(200);
    expect((await deliver({ event: 'phone.recording_completed', payload: { object: {} } })).status).toBe(200);
    expect(await rows()).toEqual([]);
  });

  it('skips the account check when accountId is null', async () => {
    const other = { ...smsSentFixture, payload: { ...smsSentFixture.payload, account_id: 'acct_other' } };
    await deliver(other, { config: testConfig({ accountId: null }) });
    expect(await rows()).toHaveLength(1);
  });
});

describe('POST /webhooks/zoom: privacy', () => {
  it('no message text reaches D1, the queue or a log; logs carry no phone number or name', async () => {
    const logs: string[] = [];
    const capture = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    const spies = [vi.spyOn(console, 'log').mockImplementation(capture), vi.spyOn(console, 'error').mockImplementation(capture)];
    try {
      sendFails = true;
      await deliver(smsReceivedFixture);
      sendFails = false;
      for (const fixture of [smsSentFixture, smsReceivedFixture, callerFixture]) await deliver(fixture);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const stored = JSON.stringify(await rows());
    expect(stored).not.toContain('SECRET-TEXT');
    expect(JSON.stringify(sent)).not.toContain('SECRET-TEXT');
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain('SECRET-TEXT');
      expect(line).not.toMatch(/555|0123|0100/);
      expect(line).not.toMatch(/Jane|Ann|example\.org/);
    }
  });
});
