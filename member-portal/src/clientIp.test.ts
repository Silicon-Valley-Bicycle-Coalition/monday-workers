import { describe, it, expect } from 'vitest';
import { clientIpKey, rateLimitIpKey } from './clientIp';

describe('rateLimitIpKey', () => {
  it('leaves an IPv4 address as it is', () => {
    expect(rateLimitIpKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys every address in one IPv6 /64 the same', () => {
    const a = rateLimitIpKey('2001:db8:12:3400:1:2:3:4');
    expect(a).toBe('2001:db8:12:3400::/64');
    expect(rateLimitIpKey('2001:0DB8:0012:3400:ffff:ffff:ffff:ffff')).toBe(a);
  });

  it('keys different /64s apart', () => {
    expect(rateLimitIpKey('2001:db8:12:3401::1')).not.toBe(rateLimitIpKey('2001:db8:12:3400::1'));
  });

  it('expands :: before taking the prefix', () => {
    expect(rateLimitIpKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitIpKey('::1')).toBe('0:0:0:0::/64');
  });

  it('leaves IPv4-mapped and malformed values as they are', () => {
    expect(rateLimitIpKey('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
    expect(rateLimitIpKey('not:an:ip')).toBe('not:an:ip');
  });
});

describe('clientIpKey', () => {
  it('falls back when the header is missing', () => {
    expect(clientIpKey(undefined)).toBe('unknown');
    expect(clientIpKey(null, 'local')).toBe('local');
  });
});
