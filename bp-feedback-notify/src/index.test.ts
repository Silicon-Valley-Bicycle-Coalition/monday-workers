import { beforeEach, describe, it, expect, vi } from 'vitest';
import app, { type Env } from './index';

// The real write-back is unit-tested in sendStatus.test.ts; here it's a spy so a test can make it
// hang and check the webhook response doesn't wait for it.
const { writeSendStatus } = vi.hoisted(() => ({ writeSendStatus: vi.fn(async () => {}) }));
vi.mock('./sendStatus', () => ({ writeSendStatus }));

// The board read is unit-tested in feedbackItem.test.ts; here it answers with the item's own
// address and event name, which differ from anything a request body claims.
const BOARD_ITEM = { kind: 'ok', eventName: 'Fall Festival', organizerEmail: 'organizer@example.org' } as const;
const { readFeedbackItem } = vi.hoisted(() => ({ readFeedbackItem: vi.fn() }));
vi.mock('./feedbackItem', () => ({ readFeedbackItem }));
// The D1 resend guard is unit-tested against real SQLite in sendGuard.test.ts; here it's a spy.
const { claimSend, releaseSend } = vi.hoisted(() => ({ claimSend: vi.fn(), releaseSend: vi.fn() }));
vi.mock('./sendGuard', () => ({ claimSend, releaseSend }));
beforeEach(() => {
  readFeedbackItem.mockReset();
  readFeedbackItem.mockResolvedValue(BOARD_ITEM);
  claimSend.mockReset();
  claimSend.mockResolvedValue(true);
  releaseSend.mockReset();
  releaseSend.mockResolvedValue(undefined);
});

const SECRET = 'test-secret';
const TOKEN = 'test-monday-token';

function fakeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext & {
    waitUntil: ReturnType<typeof vi.fn>;
  };
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    WEBHOOK_SECRET: SECRET,
    MONDAY_API_TOKEN: TOKEN,
    EMAIL: { send: vi.fn().mockResolvedValue({ messageId: 'test-id' }) },
    REQUEST_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    // Existing behavior is tested under `on`; the write-switch block below overrides it.
    FLAGS: { get: vi.fn().mockResolvedValue('on') } as unknown as KVNamespace,
    DB: {} as D1Database,
    ...overrides,
  };
}

// What monday's automation sends today. Only itemId is trusted; the rest must be ignored (#66).
const VALID_BODY = {
  itemId: 13089808285,
  itemName: 'Test Event',
  organizerEmail: 'organizer@example.org',
  eventName: 'Fall Festival',
};
const SPOOFED_BODY = { itemId: VALID_BODY.itemId, organizerEmail: 'victim@example.com', eventName: 'Free money\r\nBcc: everyone@example.com' };

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
    const res = await app.request(post({ ...VALID_BODY, itemId: 'not-a-number' }), undefined, env, fakeCtx());
    expect(res.status).toBe(400);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(readFeedbackItem).not.toHaveBeenCalled();
  });

  it('reads the recipient and event name from the board, ignoring the ones in the body (#66)', async () => {
    const env = fakeEnv();
    const res = await app.request(post(SPOOFED_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(200);
    expect(readFeedbackItem).toHaveBeenCalledWith(expect.objectContaining({ boardId: '18395469629' }), expect.any(Function), VALID_BODY.itemId, null);
    // The token reaches the Monday helpers as a provider (src/mondayApi.ts tokenProviderFor).
    expect(await (readFeedbackItem.mock.calls[0]![1] as () => Promise<string>)()).toBe(TOKEN);
    const sent = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.to).toBe('organizer@example.org');
    expect(sent.subject).toContain('Fall Festival');
    expect(JSON.stringify(sent)).not.toContain('victim@example.com');
    expect(JSON.stringify(sent)).not.toContain('Free money');
  });

  it('keeps a CR/LF in the board\'s event name out of the Subject', async () => {
    readFeedbackItem.mockResolvedValue({ ...BOARD_ITEM, eventName: 'Fall Festival\r\nBcc: everyone@example.com' });
    const env = fakeEnv();
    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(200);
    const sent = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.subject).toContain('Fall Festival Bcc: everyone@example.com');
  });

  it.each(['not-found', 'wrong-board'] as const)('%s: 404, no send, no status write-back', async (kind) => {
    readFeedbackItem.mockResolvedValue({ kind });
    writeSendStatus.mockClear();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = fakeEnv();
    const ctx = fakeCtx();

    const res = await app.request(post(VALID_BODY), undefined, env, ctx);

    expect(res.status).toBe(404);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(writeSendStatus).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-item-refused'));
    errorSpy.mockRestore();
  });

  it('already-sent item: 200, no send, no status write (#105)', async () => {
    readFeedbackItem.mockResolvedValue({ kind: 'already-sent' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = fakeEnv();
    const ctx = fakeCtx();
    writeSendStatus.mockClear();

    const res = await app.request(post(VALID_BODY), undefined, env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, alreadySent: true, itemId: VALID_BODY.itemId });
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(writeSendStatus).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('claims the item in D1 before sending, with the configured 24-hour cooldown (#105)', async () => {
    const env = fakeEnv();
    const before = Date.now();
    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(200);
    expect(claimSend).toHaveBeenCalledTimes(1);
    const [db, itemId, now, cooldown] = claimSend.mock.calls[0]!;
    expect(db).toBe(env.DB);
    expect(itemId).toBe(VALID_BODY.itemId);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(cooldown).toBe(24 * 3_600_000);
    expect(claimSend.mock.invocationCallOrder[0]!).toBeLessThan((env.EMAIL.send as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    expect(releaseSend).not.toHaveBeenCalled();
  });

  it('item emailed within the cooldown: 200, no send, no status write (#105)', async () => {
    claimSend.mockResolvedValue(false);
    writeSendStatus.mockClear();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = fakeEnv();

    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, alreadySent: true, itemId: VALID_BODY.itemId });
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(writeSendStatus).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-resend-cooldown'));
    logSpy.mockRestore();
  });

  it.each([
    ['a D1 error', () => claimSend.mockRejectedValue(new Error('D1_ERROR: no such table: sends')), {}],
    ['a missing DB binding', () => {}, { DB: undefined }],
  ] as const)('%s on the resend guard: 503 so monday retries, and no send (fail closed)', async (_label, arrange, overrides) => {
    arrange();
    writeSendStatus.mockClear();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = fakeEnv(overrides as Partial<Env>);

    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(503);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(writeSendStatus).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-guard-failed'));
    errorSpy.mockRestore();
  });

  it('a failed send releases its own claim so a retry goes through', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = fakeEnv({ EMAIL: { send: vi.fn().mockRejectedValue(new Error('boom')) } });
    const ctx = fakeCtx();

    const res = await app.request(post(VALID_BODY), undefined, env, ctx);

    expect(res.status).toBe(500);
    const claimedAt = claimSend.mock.calls[0]![2];
    expect(releaseSend).toHaveBeenCalledWith(env.DB, VALID_BODY.itemId, claimedAt);
    errorSpy.mockRestore();
  });

  it.each([
    ['not-found', 404],
    ['wrong-board', 404],
    ['already-sent', 200],
    ['no-email', 422],
  ] as const)('%s item: no claim taken', async (kind, status) => {
    readFeedbackItem.mockResolvedValue({ kind });
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    const res = await app.request(post(VALID_BODY), undefined, fakeEnv(), fakeCtx());
    expect(res.status).toBe(status);
    expect(claimSend).not.toHaveBeenCalled();
    quiet.forEach((spy) => spy.mockRestore());
  });

  it('no address on the item: 422, no send, writes Failed back', async () => {
    readFeedbackItem.mockResolvedValue({ kind: 'no-email' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = fakeEnv();
    const ctx = fakeCtx();

    const res = await app.request(post(VALID_BODY), undefined, env, ctx);

    expect(res.status).toBe(422);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(writeSendStatus).toHaveBeenLastCalledWith(null, expect.any(Function), VALID_BODY.itemId, 'failed');
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('a failed board read: 502 so monday retries, and no send', async () => {
    readFeedbackItem.mockRejectedValue(new Error('HTTP 503'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = fakeEnv();

    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(502);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('bp-feedback-item-read-failed'));
    errorSpy.mockRestore();
  });

  it('fails closed with neither MONDAY_AUTH nor MONDAY_API_TOKEN: 500, no read, no send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = fakeEnv({ MONDAY_API_TOKEN: undefined });

    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(500);
    expect(readFeedbackItem).not.toHaveBeenCalled();
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/bp-feedback-misconfigured.*MONDAY_AUTH.*MONDAY_API_TOKEN/));
    errorSpy.mockRestore();
  });

  it('builds its Monday token from the MONDAY_AUTH binding when bound', async () => {
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    const env = fakeEnv({ MONDAY_API_TOKEN: undefined, MONDAY_AUTH: auth });

    const res = await app.request(post(VALID_BODY), undefined, env, fakeCtx());

    expect(res.status).toBe(200);
    // The board read and the status write-back are handed the broker's provider, not a string.
    const token = readFeedbackItem.mock.calls[0]![1] as () => Promise<string>;
    expect(typeof token).toBe('function');
    expect(await token()).toBe('brokered');
    expect(auth.token).toHaveBeenCalled();
    expect((writeSendStatus.mock.calls.at(-1) as unknown[])[1]).toBe(token);
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
    expect(writeSendStatus).toHaveBeenLastCalledWith(null, expect.any(Function), VALID_BODY.itemId, outcome);
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
    expect(readFeedbackItem).not.toHaveBeenCalled();
    expect(claimSend).not.toHaveBeenCalled();
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
    expect(readFeedbackItem).not.toHaveBeenCalled();
    expect(writeSendStatus).not.toHaveBeenCalled();
  });

  it('still rejects an unauthorized request before reading the mode', async () => {
    const env = fakeEnv({ FLAGS: flags('on') });
    const res = await app.request(post(VALID_BODY, {}), undefined, env, fakeCtx());
    expect(res.status).toBe(401);
    expect(env.FLAGS!.get).not.toHaveBeenCalled();
  });
});
