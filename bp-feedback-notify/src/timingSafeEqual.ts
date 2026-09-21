const encoder = new TextEncoder();

// Constant-time string comparison so a webhook caller can't recover the secret one byte at a
// time by timing how long a mismatch takes to reject (a plain `===` returns as soon as it hits
// the first differing byte). Implemented by hand rather than via crypto.subtle.timingSafeEqual
// or node:crypto's version of the same name: the former is a workerd-only, non-standard
// extension unavailable under this Worker's plain-vitest (non-workerd) test runner, and the
// latter needs the nodejs_compat compatibility flag, which this Worker doesn't otherwise need.
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);

  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}
