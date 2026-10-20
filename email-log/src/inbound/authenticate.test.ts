import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_AUTHSERV_ID } from '../config';
import { testConfig } from '../test/testConfig';
import { authenticateSender, type HeaderLine } from './authenticate';

const mail = testConfig({
  mail: { staffDomains: ['bikesiliconvalley.org'], trustedAuthServId: 'mx.cloudflare.net' },
}).mail;

const ar = (value: string): HeaderLine => ({ key: 'authentication-results', value });
const pass = 'mx.cloudflare.net; dkim=pass header.d=bikesiliconvalley.org header.s=google header.b=AbC; spf=pass smtp.mailfrom=bikesiliconvalley.org; dmarc=pass header.from=bikesiliconvalley.org';
const FROM = 'Dana@bikesiliconvalley.org';

describe('authenticateSender', () => {
  it('accepts a staff From with dkim=pass header.d=bikesiliconvalley.org', () => {
    expect(authenticateSender([ar(pass)], FROM, mail)).toEqual({ ok: true, staffEmail: 'dana@bikesiliconvalley.org' });
  });

  it('rejects a non-staff From', () => {
    expect(authenticateSender([ar(pass)], 'x@gmail.com', mail)).toEqual({ ok: false, reason: 'not-staff' });
  });

  it('does not treat a subdomain of a staff domain as staff', () => {
    expect(authenticateSender([ar(pass)], 'x@log.bikesiliconvalley.org', mail)).toEqual({ ok: false, reason: 'not-staff' });
  });

  it('rejects when no trusted Authentication-Results header exists', () => {
    expect(authenticateSender([], FROM, mail)).toEqual({ ok: false, reason: 'dkim-missing' });
    const other = pass.replace('mx.cloudflare.net', 'mx.google.com');
    expect(authenticateSender([ar(other)], FROM, mail)).toEqual({ ok: false, reason: 'dkim-missing' });
  });

  it('rejects when the trusted header carries no dkim result', () => {
    expect(authenticateSender([ar('mx.cloudflare.net; spf=pass smtp.mailfrom=bikesiliconvalley.org')], FROM, mail)).toEqual({
      ok: false,
      reason: 'dkim-missing',
    });
  });

  it('rejects dkim=fail', () => {
    const v = 'mx.cloudflare.net; dkim=fail header.d=bikesiliconvalley.org';
    expect(authenticateSender([ar(v)], FROM, mail)).toEqual({ ok: false, reason: 'dkim-fail' });
  });

  it('rejects dkim=pass for another domain (header.d=gmail.com)', () => {
    const v = 'mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=x';
    expect(authenticateSender([ar(v)], FROM, mail)).toEqual({ ok: false, reason: 'dkim-fail' });
  });

  it('accepts any staff dkim=pass among several signatures', () => {
    const v = 'mx.cloudflare.net; dkim=pass header.d=gmail.com; dkim=pass header.d=bikesiliconvalley.org';
    expect(authenticateSender([ar(v)], FROM, mail).ok).toBe(true);
  });

  it('falls back to the domain of header.i', () => {
    const v = 'mx.cloudflare.net; dkim=pass header.i=@Bikesiliconvalley.org';
    expect(authenticateSender([ar(v)], FROM, mail).ok).toBe(true);
    const v2 = 'mx.cloudflare.net; dkim=pass header.i=dana@bikesiliconvalley.org';
    expect(authenticateSender([ar(v2)], FROM, mail).ok).toBe(true);
  });

  it("ignores a forged header below Cloudflare's", () => {
    const failing = 'mx.cloudflare.net; dkim=fail header.d=bikesiliconvalley.org';
    expect(authenticateSender([ar(failing), ar(pass)], FROM, mail)).toEqual({ ok: false, reason: 'dkim-fail' });
  });

  it('ignores a forged header with another authserv-id above the trusted one', () => {
    const forged = ar(pass.replace('mx.cloudflare.net', 'evil.example.com'));
    const real = ar('mx.cloudflare.net; dkim=fail header.d=bikesiliconvalley.org');
    expect(authenticateSender([forged, real], FROM, mail)).toEqual({ ok: false, reason: 'dkim-fail' });
  });

  it('does not accept an authserv-id that merely starts with the trusted one', () => {
    expect(authenticateSender([ar(pass.replace('mx.cloudflare.net', 'mx.cloudflare.net.evil.com'))], FROM, mail)).toEqual({
      ok: false,
      reason: 'dkim-missing',
    });
  });

  it('honours a non-empty staffSenders allowlist', () => {
    const m = { ...mail, staffSenders: ['alex@bikesiliconvalley.org'] };
    expect(authenticateSender([ar(pass)], FROM, m)).toEqual({ ok: false, reason: 'not-allowlisted' });
    expect(authenticateSender([ar(pass)], 'ALEX@bikesiliconvalley.org', m)).toEqual({ ok: true, staffEmail: 'alex@bikesiliconvalley.org' });
  });

  it('matches the staff domain case-insensitively and returns the lowercased address', () => {
    const m = { ...mail, staffDomains: ['BikeSiliconValley.org'] };
    expect(authenticateSender([ar(pass)], 'Dana@BIKESILICONVALLEY.ORG', m)).toEqual({ ok: true, staffEmail: 'dana@bikesiliconvalley.org' });
  });

  it('checks staff before allowlist before dkim', () => {
    const m = { ...mail, staffSenders: ['alex@bikesiliconvalley.org'] };
    expect(authenticateSender([], 'x@gmail.com', m)).toEqual({ ok: false, reason: 'not-staff' });
    expect(authenticateSender([], FROM, m)).toEqual({ ok: false, reason: 'not-allowlisted' });
  });

  it('fails closed while trustedAuthServId is the placeholder', () => {
    const m = { ...mail, trustedAuthServId: PLACEHOLDER_AUTHSERV_ID };
    const v = pass.replace('mx.cloudflare.net', PLACEHOLDER_AUTHSERV_ID);
    expect(authenticateSender([ar(v)], FROM, m)).toEqual({ ok: false, reason: 'dkim-missing' });
  });
});
