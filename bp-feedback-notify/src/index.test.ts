import { describe, it, expect, vi } from 'vitest';
import app, { type Env } from './index';

const SECRET = 'test-secret';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    WEBHOOK_SECRET: SECRET,
    EMAIL: { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) },
    REQUEST_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
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
    const res = await app.request(post(VALID_BODY, {}), undefined, env);
    expect(res.status).toBe(401);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong secret', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY, { 'X-Webhook-Secret': 'nope' }), undefined, env);
    expect(res.status).toBe(401);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('accepts the secret as a ?secret= query param, since monday.com\'s webhook action has no custom-header field', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY, {}, `?secret=${SECRET}`), undefined, env);
    expect(res.status).toBe(200);
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
  });

  it('rejects the wrong secret given as a query param', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY, {}, '?secret=nope'), undefined, env);
    expect(res.status).toBe(401);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('echoes back a monday.com connection-verification challenge instead of treating it as a feedback payload', async () => {
    const env = fakeEnv();
    const res = await app.request(post({ challenge: 'abc123' }), undefined, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('still requires the secret before answering a challenge', async () => {
    const env = fakeEnv();
    const res = await app.request(post({ challenge: 'abc123' }, {}), undefined, env);
    expect(res.status).toBe(401);
  });

  it('rejects an invalid payload with 400 and does not send', async () => {
    const env = fakeEnv();
    const res = await app.request(post({ ...VALID_BODY, organizerEmail: 'not-an-email' }), undefined, env);
    expect(res.status).toBe(400);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('sends the feedback email straight to the organizer in production', async () => {
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY), undefined, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, itemId: VALID_BODY.itemId });
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
    const sent = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.to).toBe('organizer@example.org');
    expect(sent.subject).toContain('Fall Festival');
  });

  it('redirects to the sandbox sink instead of the organizer when ENVIRONMENT=sandbox', async () => {
    const env = fakeEnv({ ENVIRONMENT: 'sandbox', SANDBOX_EMAIL_SINK: 'sandbox@bikesiliconvalley.org' });
    const res = await app.request(post(VALID_BODY), undefined, env);

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

    const res = await app.request(post(VALID_BODY), undefined, env);

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

  it('logs a successful send', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await app.request(post(VALID_BODY), undefined, fakeEnv());
    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-sent'));
    logSpy.mockRestore();
  });

  it('fails closed if ENVIRONMENT=sandbox but no sink is configured', async () => {
    const env = fakeEnv({ ENVIRONMENT: 'sandbox' });
    const res = await app.request(post(VALID_BODY), undefined, env);
    expect(res.status).toBe(500);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });
});
