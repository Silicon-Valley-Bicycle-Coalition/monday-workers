import { describe, it, expect, vi } from 'vitest';
import app, { type Env } from './index';

// The real write-back is unit-tested in sendStatus.test.ts; here it's a spy so a test can make it
// hang and check the webhook response doesn't wait for it.
const { writeSendStatus } = vi.hoisted(() => ({ writeSendStatus: vi.fn(async () => {}) }));
vi.mock('./sendStatus', () => ({ writeSendStatus }));

const SECRET = 'test-secret';

function fakeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext & {
    waitUntil: ReturnType<typeof vi.fn>;
  };
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    WEBHOOK_SECRET: SECRET,
    EMAIL: { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) },
    REQUEST_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    // Existing behavior is tested under `on`; the write-switch block below overrides it.
    FLAGS: { get: vi.fn().mockResolvedValue('on') } as unknown as KVNamespace,
    ...overrides,
  };
}

const VALID_BODY = {
  itemId: 13089808285,
  itemName: 'Test Event',
  organizerEmail: 'organizer@example.org',
  eventName: 'Fall Festival',
};

function post(body: unknown, headers: Record<string, string> = { 'X-Webhook-Secret': SECRET }, query = '') {
  return new Request(`http://worker/webhook/bp-feedback${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /webhook/bp-feedback', () => {
  it('rejects a request with no secret header', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY, {}), undefined, env, fakeCtx());
    expect(res.status).toBe(401);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong secret', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY, { 'X-Webhook-Secret': 'nope' }), undefined, env, fakeCtx());
    expect(res.status).toBe(401);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('accepts the secret as a ?secret= query param, since monday.com\'s webhook action has no custom-header field', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY, {}, `?secret=${SECRET}`), undefined, env, fakeCtx());
    expect(res.status).toBe(200);
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
  });

  it('rejects the wrong secret given as a query param', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY, {}, '?secret=nope'), undefined, env, fakeCtx());
    expect(res.status).toBe(401);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('echoes back a monday.com connection-verification challenge instead of treating it as a feedback payload', async () => {
    const env = fakeEnv();
    const res = await app.request(post({ challenge: 'abc123' }), undefined, env, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('still requires the secret before answering a challenge', async () => {
    const env = fakeEnv();
    const res = await app.request(post({ challenge: 'abc123' }, {}), undefined, env, fakeCtx());
    expect(res.status).toBe(401);
  });

  it('rejects an invalid payload with 400 and does not send', async () => {
    const env = fakeEnv();
    const res = await app.request(post({ ...VALID_BODY, organizerEmail: 'not-an-email' }), undefined, env, fakeCtx());
    expect(res.status).toBe(400);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('sends the feedback email straight to the organizer in production', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, itemId: VALID_BODY.itemId });
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
    const sent = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.to).toBe('organizer@example.org');
    expect(sent.subject).toContain('Fall Festival');
  });

  it('redirects to the sandbox sink instead of the organizer when ENVIRONMENT=sandbox', async () => {
    const env = fakeEnv({ ENVIRONMENT: 'sandbox', SANDBOX_EMAIL_SINK: 'sandbox@bikesiliconvalley.org' });
    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(200);
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
    const sent = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.to).toBe('sandbox@bikesiliconvalley.org');
    expect(sent.subject).toContain('organizer@example.org');
  });

  it('logs a failed send and answers 500 with sent: false', async () => {
    const env = fakeEnv({ EMAIL: { send: vi.fn().mockRejectedValue(new Error('destination address is not a verified address')) } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ sent: false, itemId: VALID_BODY.itemId });
    const logged = JSON.parse(errorSpy.mock.calls.find(([line]) => String(line).includes('bp-feedback-send-failed'))![0] as string);
    expect(logged).toMatchObject({ itemId: VALID_BODY.itemId, error: 'destination address is not a verified address' });
    expect(JSON.stringify(logged)).not.toContain('organizer@example.org'); // no PII in logs
    // Status write-back ships disabled (sendStatus: null in both configs), so no Monday call.
    expect(fetchSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('redacts the organizer address from a send error before logging it', async () => {
    const send = vi.fn().mockRejectedValue(new Error('destination address Organizer@example.org is not a verified address'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(post(VALID_BODY), undefined, fakeEnv({ EMAIL: { send } }), fakeCtx());

    expect(res.status).toBe(500);
    const line = errorSpy.mock.calls.map(([l]) => String(l)).find((l) => l.includes('bp-feedback-send-failed'))!;
    expect(line.toLowerCase()).not.toContain('organizer@example.org');
    expect(JSON.parse(line).error).toBe('destination address [redacted] is not a verified address');
    errorSpy.mockRestore();
  });

  it.each([
    ['sent', 200, vi.fn().mockResolvedValue({ messageId: 'test-id' })],
    ['failed', 500, vi.fn().mockRejectedValue(new Error('boom'))],
  ] as const)('answers without waiting on the %s status write-back, handing it to waitUntil', async (outcome, status, send) => {
    writeSendStatus.mockReturnValueOnce(new Promise<void>(() => {})); // a Monday API that never answers
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = fakeCtx();

    const res = await app.request(post(VALID_BODY), undefined, fakeEnv({ EMAIL: { send } }), ctx);

    expect(res.status).toBe(status);
    expect(writeSendStatus).toHaveBeenLastCalledWith(null, undefined, VALID_BODY.itemId, outcome);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil.mock.calls[0]![0]).toBe(writeSendStatus.mock.results.at(-1)!.value);
    errorSpy.mockRestore();
  });

  it('logs a successful send', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await app.request(post(VALID_BODY), undefined, fakeEnv(), fakeCtx());
    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-sent'));
    logSpy.mockRestore();
  });

  it('fails closed if ENVIRONMENT=sandbox but no sink is configured', async () => {
    const env = fakeEnv({ ENVIRONMENT: 'sandbox' });
    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());
    expect(res.status).toBe(500);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });
});

describe('write switch (FLAGS)', () => {
  const flags = (value: string | null | Error) =>
    ({ get: vi.fn(async () => { if (value instanceof Error) throw value; return value; }) }) as unknown as KVNamespace;

  it('reads the mode from <worker>:writes', async () => {
    const env = fakeEnv({ FLAGS: flags('on') });
    await app.request(post(VALID_BODY), undefined, env, fakeCtx());
    expect(env.FLAGS!.get).toHaveBeenCalledWith('bp-feedback-notify:writes', { cacheTtl: 30 });
  });

  it('answers a challenge without reading the mode', async () => {
    const env = fakeEnv({ FLAGS: flags('hold') });
    const res = await app.request(post({ challenge: 'abc123' }), undefined, env, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
    expect(env.FLAGS!.get).not.toHaveBeenCalled();
  });

  it.each([
    ['off', 'off'],
    ['a missing key', null],
  ] as const)('%s: logs a masked skip, returns 200, sends nothing and writes no status', async (_label, value) => {
    writeSendStatus.mockClear();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = fakeEnv({ FLAGS: flags(value) });
    const ctx = fakeCtx();
    const res = await app.request(post(VALID_BODY), undefined, env, ctx);
    expect(res.status).toBe(200);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(writeSendStatus).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    const lines = logSpy.mock.calls.map(([l]) => String(l));
    expect(lines.some((l) => l.includes('skipped'))).toBe(true);
    expect(lines.join('\n')).not.toContain('@');
    logSpy.mockRestore();
  });

  it('off with debug logging still masks the organizer address and event name', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const get = vi.fn(async (key: string) => (key.endsWith(':log') ? 'debug' : 'off'));
    const res = await app.request(post(VALID_BODY), undefined, fakeEnv({ FLAGS: { get } as unknown as KVNamespace }), fakeCtx());
    expect(res.status).toBe(200);
    const text = logSpy.mock.calls.map(([l]) => String(l)).join('\n');
    expect(text).not.toContain('@');
    expect(text).not.toContain('Fall Festival');
    logSpy.mockRestore();
  });

  it.each([
    ['hold', flags('hold')],
    ['a KV read error (unknown)', flags(new Error('kv down'))],
    ['a missing FLAGS binding', undefined],
  ] as const)('%s: 503 and no send', async (_label, binding) => {
    writeSendStatus.mockClear();
    const env = fakeEnv({ FLAGS: binding });
    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());
    expect(res.status).toBe(503);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(writeSendStatus).not.toHaveBeenCalled();
  });

  it('still rejects an unauthorized request before reading the mode', async () => {
    const env = fakeEnv({ FLAGS: flags('on') });
    const res = await app.request(post(VALID_BODY, {}), undefined, env, fakeCtx());
    expect(res.status).toBe(401);
    expect(env.FLAGS!.get).not.toHaveBeenCalled();
  });
});
