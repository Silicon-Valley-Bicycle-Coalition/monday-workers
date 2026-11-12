import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp } from './route';
import type { PendingStore } from '../db/pending';
import type { WriteMode } from '../flags';
import type { MondayJwtPolicy } from '../mondayJwt';

// Issue #110: the Authorization JWT Monday signs app-created webhooks with, checked after the URL
// secret. Kept out of route.test.ts so it doesn't collide with other work on that file.
const SIGNING_SECRET = 'app-signing-secret';
const ACCOUNT = '26331880';
const EVENT = { event: { type: 'create_pulse', pulseId: 555, boardId: 1 } };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
async function sign(claims: Record<string, unknown>, secret = SIGNING_SECRET): Promise<string> {
  const input = `${encodeJson({ alg: 'HS256', typ: 'JWT' })}.${encodeJson(claims)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))))}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

function setup(jwtPolicy?: MondayJwtPolicy) {
  const send = vi.fn().mockResolvedValue(undefined);
  const pendingStore: PendingStore = {
    upsertPending: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockResolvedValue(null),
    listStuck: vi.fn().mockResolvedValue([]),
  };
  const app = createApp({
    writeMode: async (): Promise<WriteMode> => 'on', pendingStore, queue: { send }, donationBoardIds: new Set(['1']),
    registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh', ...(jwtPolicy ? { jwtPolicy } : {}),
  });
  const post = (body: unknown, authorization?: string, query = '?secret=shh') => app.request(`/webhooks/monday/donations${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorization !== undefined ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
  });
  return { post, send };
}

describe('webhook JWT (issue #110)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a delivery with a valid JWT', async () => {
    const { post, send } = setup({ signingSecret: SIGNING_SECRET, accountId: ACCOUNT });
    const res = await post(EVENT, await sign({ accountId: 26331880, aud: 'http://localhost/webhooks/monday/donations', iat: nowSec(), exp: nowSec() + 60 }));
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ['a token signed with another secret', async () => sign({ accountId: 26331880, exp: nowSec() + 60 }, 'other')],
    ['an expired token', async () => sign({ accountId: 26331880, exp: nowSec() - 3600 })],
    ['a malformed token', async () => 'not-a-jwt'],
    ['a token for another Monday account', async () => sign({ accountId: 12345, exp: nowSec() + 60 })],
    ['a token for another endpoint', async () => sign({ accountId: 26331880, aud: 'http://localhost/webhooks/other', exp: nowSec() + 60 })],
    ['a token with a day-long lifetime', async () => sign({ accountId: 26331880, iat: nowSec(), exp: nowSec() + 86_400 })],
  ])('rejects %s with 401 and enqueues nothing', async (_label, token) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post, send } = setup({ signingSecret: SIGNING_SECRET, accountId: ACCOUNT });
    const res = await post(EVENT, await token());
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('JWT'));
  });

  it('rejects a tampered payload with 401', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const [h, , s] = (await sign({ accountId: 26331880, exp: nowSec() + 60 })).split('.');
    const { post, send } = setup({ signingSecret: SIGNING_SECRET, accountId: ACCOUNT });
    const res = await post(EVENT, `${h}.${encodeJson({ accountId: 12345, exp: nowSec() + 60 })}.${s}`);
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('still requires the URL secret alongside a valid JWT', async () => {
    const { post, send } = setup({ signingSecret: SIGNING_SECRET, accountId: ACCOUNT });
    const res = await post(EVENT, await sign({ accountId: 26331880, exp: nowSec() + 60 }), '?secret=nope');
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts a delivery with no JWT while not required, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { post, send } = setup({ signingSecret: SIGNING_SECRET, accountId: ACCOUNT });
    const res = await post(EVENT);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Authorization JWT'));
  });

  it('rejects a delivery with no JWT once required', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post, send } = setup({ signingSecret: SIGNING_SECRET, required: true, accountId: ACCOUNT });
    expect((await post(EVENT)).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed when required but the signing secret is unset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post, send } = setup({ required: true, accountId: ACCOUNT });
    expect((await post(EVENT, await sign({ accountId: 26331880, exp: nowSec() + 60 }))).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('without a signing secret, behaves as before: the URL secret alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { post, send } = setup();
    expect((await post(EVENT)).status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers the subscription challenge without a JWT, even when required', async () => {
    const { post } = setup({ signingSecret: SIGNING_SECRET, required: true, accountId: ACCOUNT });
    const res = await post({ challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });
});
