// Zoom webhook authentication (https://developers.zoom.us/docs/api/webhooks/):
//   x-zm-signature = "v0=" + hex(HMAC-SHA256(secret, "v0:{x-zm-request-timestamp}:{raw body}"))
// and the endpoint.url_validation answer is hex(HMAC-SHA256(secret, plainToken)).

export const SIGNATURE_HEADER = 'x-zm-signature';
export const TIMESTAMP_HEADER = 'x-zm-request-timestamp';

// Deliveries whose timestamp is further than this from our clock are rejected (replay guard).
export const MAX_SKEW_SECONDS = 5 * 60;

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// null for anything that isn't exactly 32 bytes of hex (an HMAC-SHA256).
function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'mismatch';

/**
 * Checks a delivery's signature and timestamp. The comparison is crypto.subtle.verify, which is
 * constant-time, so no timing difference reveals how much of a guessed signature was right.
 * A missing or empty secret never verifies (fail closed).
 */
export async function verifySignature(
  secret: string | undefined,
  headers: { signature: string | null | undefined; timestamp: string | null | undefined },
  rawBody: string,
  nowMs: number = Date.now(),
): Promise<SignatureCheck> {
  const { signature, timestamp } = headers;
  if (!secret || !signature || !timestamp) return 'missing';
  if (!/^\d{1,13}$/.test(timestamp)) return 'mismatch';
  // Zoom sends seconds; accept milliseconds too rather than reject a format change outright.
  const tsMs = timestamp.length > 11 ? Number(timestamp) : Number(timestamp) * 1000;
  if (Math.abs(nowMs - tsMs) > MAX_SKEW_SECONDS * 1000) return 'stale';
  if (!signature.startsWith('v0=')) return 'mismatch';
  const presented = fromHex(signature.slice(3));
  if (presented === null) return 'mismatch';
  const key = await hmacKey(secret, 'verify');
  const ok = await crypto.subtle.verify('HMAC', key, presented, encoder.encode(`v0:${timestamp}:${rawBody}`));
  return ok ? 'ok' : 'mismatch';
}
