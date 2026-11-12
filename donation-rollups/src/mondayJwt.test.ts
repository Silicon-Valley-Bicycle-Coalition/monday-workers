import { describe, it, expect } from 'vitest';
import { checkMondayWebhookJwt, verifyMondayJwt } from './mondayJwt';

const SECRET = 'app-signing-secret';
const NOW = 1_800_000_000;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function sign(claims: Record<string, unknown>, opts: { secret?: string; header?: Record<string, unknown> } = {}): Promise<string> {
  const input = `${encodeJson(opts.header ?? { alg: 'HS256', typ: 'JWT' })}.${encodeJson(claims)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(opts.secret ?? SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

const claims = (over: Record<string, unknown> = {}) => ({ accountId: 1, iat: NOW - 5, exp: NOW + 60, ...over });

describe('verifyMondayJwt', () => {
  it('accepts a valid HS256 token, bare or as a Bearer credential', async () => {
    const token = await sign(claims());
    expect(await verifyMondayJwt(token, SECRET, NOW)).toEqual({ ok: true, claims: claims() });
    expect((await verifyMondayJwt(`Bearer ${token}`, SECRET, NOW)).ok).toBe(true);
  });

  it('accepts a token with no exp or iat (both checked only when present)', async () => {
    expect((await verifyMondayJwt(await sign({ accountId: 1 }), SECRET, NOW)).ok).toBe(true);
  });

  it('rejects a missing or empty header', async () => {
    expect(await verifyMondayJwt(undefined, SECRET, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyMondayJwt('', SECRET, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyMondayJwt('Bearer ', SECRET, NOW)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a token signed with another secret', async () => {
    expect(await verifyMondayJwt(await sign(claims(), { secret: 'other' }), SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a tampered payload or signature', async () => {
    const [h, , s] = (await sign(claims())).split('.');
    const forged = `${h}.${encodeJson(claims({ accountId: 2 }))}.${s}`;
    expect(await verifyMondayJwt(forged, SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    const token = await sign(claims());
    const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(await verifyMondayJwt(flipped, SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an expired token, allowing 60 s of clock skew', async () => {
    expect(await verifyMondayJwt(await sign(claims({ exp: NOW - 61 })), SECRET, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect((await verifyMondayJwt(await sign(claims({ exp: NOW - 30 })), SECRET, NOW)).ok).toBe(true);
  });

  it('rejects a token issued in the future, or not valid yet', async () => {
    expect(await verifyMondayJwt(await sign(claims({ iat: NOW + 120 })), SECRET, NOW)).toEqual({ ok: false, reason: 'not-yet-valid' });
    expect(await verifyMondayJwt(await sign(claims({ nbf: NOW + 120 })), SECRET, NOW)).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('rejects any algorithm but HS256, including none', async () => {
    const token = await sign(claims(), { header: { alg: 'none' } });
    expect(await verifyMondayJwt(token, SECRET, NOW)).toEqual({ ok: false, reason: 'unsupported-alg' });
    const unsigned = `${encodeJson({ alg: 'none' })}.${encodeJson(claims())}.`;
    expect((await verifyMondayJwt(unsigned, SECRET, NOW)).ok).toBe(false);
    expect(await verifyMondayJwt(await sign(claims(), { header: { alg: 'HS512' } }), SECRET, NOW)).toEqual({ ok: false, reason: 'unsupported-alg' });
  });

  it.each([
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
    ['non-JSON header', `${b64url(new TextEncoder().encode('nope'))}.e30.sig`],
    ['non-base64url characters', 'a$b.c.d'],
    ['an oversized token', `${'a'.repeat(5000)}.b.c`],
  ])('rejects a malformed token: %s', async (_label, token) => {
    expect(await verifyMondayJwt(token, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects non-numeric exp, and a non-object payload', async () => {
    expect(await verifyMondayJwt(await sign(claims({ exp: 'soon' })), SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    const input = `${encodeJson({ alg: 'HS256' })}.${encodeJson([1, 2])}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))));
    expect(await verifyMondayJwt(`${input}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('checkMondayWebhookJwt (rollout policy)', () => {
  it('without a signing secret, accepts and says verification is off', async () => {
    expect(await checkMondayWebhookJwt(undefined, {}, NOW)).toEqual({ accept: true, verified: false, note: 'no-signing-secret' });
    expect(await checkMondayWebhookJwt('garbage', { signingSecret: '' }, NOW)).toEqual({ accept: true, verified: false, note: 'no-signing-secret' });
  });

  it('fails closed when required but no signing secret is set', async () => {
    expect(await checkMondayWebhookJwt(await sign(claims()), { required: true }, NOW)).toEqual({ accept: false, reason: 'no-signing-secret' });
  });

  it('with a signing secret, accepts a missing token (flagged) until required', async () => {
    expect(await checkMondayWebhookJwt(undefined, { signingSecret: SECRET }, NOW)).toEqual({ accept: true, verified: false, note: 'missing' });
    expect(await checkMondayWebhookJwt(undefined, { signingSecret: SECRET, required: true }, NOW)).toEqual({ accept: false, reason: 'missing' });
  });

  it('with a signing secret, a token that is present must verify, required or not', async () => {
    expect(await checkMondayWebhookJwt(await sign(claims()), { signingSecret: SECRET }, NOW)).toEqual({ accept: true, verified: true });
    expect(await checkMondayWebhookJwt(await sign(claims(), { secret: 'x' }), { signingSecret: SECRET }, NOW)).toEqual({ accept: false, reason: 'bad-signature' });
    expect(await checkMondayWebhookJwt(await sign(claims({ exp: NOW - 3600 })), { signingSecret: SECRET }, NOW)).toEqual({ accept: false, reason: 'expired' });
  });
});
