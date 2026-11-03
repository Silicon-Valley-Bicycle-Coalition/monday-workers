import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { devBypassAllowed, verifyAccess } from './access';

const access = { teamDomain: 'https://svbc.cloudflareaccess.com', aud: 'aud123', allowedEmailDomain: 'bikesiliconvalley.org' };
const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = async () => publicKey;

async function tok(claims: { email?: string; aud?: string; iss?: string; exp?: number | string }): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(claims.iss ?? 'https://svbc.cloudflareaccess.com')
    .setAudience(claims.aud ?? 'aud123')
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '5m')
    .sign(privateKey);
}
const req = (token?: string) => new Request('https://map.bikesiliconvalley.org/', token ? { headers: { 'Cf-Access-Jwt-Assertion': token } } : {});

describe('verifyAccess', () => {
  it('accepts a valid token for a staff email', async () =>
    expect(await verifyAccess(req(await tok({ email: 'pat@bikesiliconvalley.org' })), access, keys)).toEqual({ email: 'pat@bikesiliconvalley.org' }));
  it('accepts uppercase domain', async () =>
    expect(await verifyAccess(req(await tok({ email: 'Pat@BikeSiliconValley.org' })), access, keys)).not.toBeNull());
  it('rejects another domain', async () =>
    expect(await verifyAccess(req(await tok({ email: 'pat@gmail.com' })), access, keys)).toBeNull());
  it('rejects a look-alike domain', async () =>
    expect(await verifyAccess(req(await tok({ email: 'pat@evilbikesiliconvalley.org' })), access, keys)).toBeNull());
  it('rejects a token with no email', async () =>
    expect(await verifyAccess(req(await tok({})), access, keys)).toBeNull());
  it('rejects wrong aud', async () =>
    expect(await verifyAccess(req(await tok({ email: 'pat@bikesiliconvalley.org', aud: 'other' })), access, keys)).toBeNull());
  it('rejects wrong issuer', async () =>
    expect(await verifyAccess(req(await tok({ email: 'pat@bikesiliconvalley.org', iss: 'https://other.cloudflareaccess.com' })), access, keys)).toBeNull());
  it('rejects expired', async () =>
    expect(await verifyAccess(req(await tok({ email: 'pat@bikesiliconvalley.org', exp: Math.floor(Date.now() / 1000) - 3600 })), access, keys)).toBeNull());
  it('rejects a token signed by another key', async () => {
    const other = await generateKeyPair('RS256');
    const bad = await new SignJWT({ email: 'pat@bikesiliconvalley.org' })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(access.teamDomain).setAudience('aud123').setExpirationTime('5m').sign(other.privateKey);
    expect(await verifyAccess(req(bad), access, keys)).toBeNull();
  });
  it('rejects an HS256 token even when the key would verify it', async () => {
    const secret = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
    const hs = await new SignJWT({ email: 'pat@bikesiliconvalley.org' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(access.teamDomain).setAudience('aud123').setExpirationTime('5m').sign(secret);
    expect(await verifyAccess(req(hs), access, async () => secret)).toBeNull();
  });
  it('rejects a missing header', async () => expect(await verifyAccess(req(), access, keys)).toBeNull());
  it('rejects everything when teamDomain or aud is empty', async () => {
    const t = await tok({ email: 'pat@bikesiliconvalley.org' });
    expect(await verifyAccess(req(t), { ...access, aud: '' }, keys)).toBeNull();
    expect(await verifyAccess(req(t), { ...access, teamDomain: '' }, keys)).toBeNull();
  });
  it('accepts a teamDomain configured with a trailing slash', async () => {
    const t = await tok({ email: 'pat@bikesiliconvalley.org' });
    expect(await verifyAccess(req(t), { ...access, teamDomain: 'https://svbc.cloudflareaccess.com/' }, keys)).toEqual({ email: 'pat@bikesiliconvalley.org' });
  });
});

describe('devBypassAllowed', () => {
  it('needs both the var and a localhost URL', () => {
    expect(devBypassAllowed(new Request('http://localhost:8787/'), { ACCESS_DEV_BYPASS: '1' })).toBe(true);
    expect(devBypassAllowed(new Request('https://map.bikesiliconvalley.org/'), { ACCESS_DEV_BYPASS: '1' })).toBe(false);
    expect(devBypassAllowed(new Request('http://localhost:8787/'), {})).toBe(false);
  });
  it('needs the var to be exactly "1"', () => {
    for (const v of ['0', 'false', 'true', 'yes', ' 1', '']) {
      expect(devBypassAllowed(new Request('http://localhost:8787/'), { ACCESS_DEV_BYPASS: v }), v).toBe(false);
    }
  });
});
