import { describe, it, expect } from 'vitest';
import { hmacHex, verifySignature } from './signature';

const SECRET = 'test-secret';
const NOW = 1_763_600_000_000;
const TS = String(NOW / 1000);
const BODY = '{"event":"phone.sms_sent"}';

async function sign(ts = TS, body = BODY, secret = SECRET) {
  return `v0=${await hmacHex(secret, `v0:${ts}:${body}`)}`;
}

describe('verifySignature', () => {
  it('accepts a correct signature', async () => {
    expect(await verifySignature(SECRET, { signature: await sign(), timestamp: TS }, BODY, NOW)).toBe('ok');
  });

  it('rejects a signature over a different body or with another secret', async () => {
    expect(await verifySignature(SECRET, { signature: await sign(TS, '{}'), timestamp: TS }, BODY, NOW)).toBe('mismatch');
    expect(await verifySignature(SECRET, { signature: await sign(TS, BODY, 'other'), timestamp: TS }, BODY, NOW)).toBe('mismatch');
  });

  it('rejects malformed signatures', async () => {
    for (const signature of ['abc', 'v0=xyz', `v1=${'a'.repeat(64)}`, `v0=${'a'.repeat(63)}`]) {
      expect(await verifySignature(SECRET, { signature, timestamp: TS }, BODY, NOW)).toBe('mismatch');
    }
  });

  it('rejects a timestamp more than five minutes off, either way', async () => {
    const old = String(NOW / 1000 - 301);
    const future = String(NOW / 1000 + 301);
    expect(await verifySignature(SECRET, { signature: await sign(old), timestamp: old }, BODY, NOW)).toBe('stale');
    expect(await verifySignature(SECRET, { signature: await sign(future), timestamp: future }, BODY, NOW)).toBe('stale');
    const recent = String(NOW / 1000 - 299);
    expect(await verifySignature(SECRET, { signature: await sign(recent), timestamp: recent }, BODY, NOW)).toBe('ok');
  });

  it('fails closed with no secret or missing headers', async () => {
    const signature = await sign();
    expect(await verifySignature(undefined, { signature, timestamp: TS }, BODY, NOW)).toBe('missing');
    expect(await verifySignature('', { signature, timestamp: TS }, BODY, NOW)).toBe('missing');
    expect(await verifySignature(SECRET, { signature: null, timestamp: TS }, BODY, NOW)).toBe('missing');
    expect(await verifySignature(SECRET, { signature, timestamp: undefined }, BODY, NOW)).toBe('missing');
  });

  it('hmacHex matches a known HMAC-SHA256 vector (RFC 4231 case 2)', async () => {
    expect(await hmacHex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});
