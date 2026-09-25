/**
 * Constant-time comparison of a presented shared secret against the configured one (issue #32).
 * Both sides are hashed to fixed-length SHA-256 digests first, so neither the content nor the
 * length of the real secret leaks through timing, then every digest byte is compared with no
 * early exit. (Hand-rolled rather than workerd's crypto.subtle.timingSafeEqual because this
 * project's tsconfig types the global `crypto` from the DOM lib, which lacks it.) A missing or
 * empty value on either side never matches — an unprovisioned secret fails closed.
 *
 * Mirrors funraise-sync's secretsMatch; each Worker stays self-contained (no shared package).
 */
export async function secretsMatch(presented: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
