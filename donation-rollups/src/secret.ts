// Shared-secret check for the Monday webhook route and the /custodian/* routes (issue #27).
// Same shape as funraise-sync's secretsMatch — copied, not shared, since every Worker in this
// repo is self-contained.
//
// Fails closed: an unset or empty configured secret authorizes nobody, and an absent or empty
// presented secret never matches. Both sides are hashed to a fixed-length SHA-256 digest and
// compared with a full-length XOR fold, so neither the length nor the position of the first
// differing byte leaks through response timing.
export async function secretsMatch(presented: string | undefined, expected: string | undefined): Promise<boolean> {
  if (presented === undefined || presented === '' || expected === undefined || expected === '') return false;
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
