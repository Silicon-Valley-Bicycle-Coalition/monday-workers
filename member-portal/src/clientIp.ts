// The key a per-IP rate limit counts under. An IPv4 address is its own key. An IPv6 client is
// usually handed a whole /64, so the address alone would give one subscriber 2^64 fresh keys:
// IPv6 counts by its /64 prefix instead.
export function rateLimitIpKey(ip: string): string {
  // Not IPv6, or an IPv4-mapped form (::ffff:203.0.113.7): nothing to widen.
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head = '', tail] = ip.toLowerCase().split('::');
  const groups = head === '' ? [] : head.split(':');
  if (tail !== undefined) {
    const tailGroups = tail === '' ? [] : tail.split(':');
    while (groups.length + tailGroups.length < 8) groups.push('0');
    groups.push(...tailGroups);
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// CF-Connecting-IP is set by Cloudflare's edge on every Internet request; local dev and tests
// never see it, so they share one fixed key.
export function clientIpKey(header: string | undefined | null, fallback = 'unknown'): string {
  return header ? rateLimitIpKey(header) : fallback;
}
