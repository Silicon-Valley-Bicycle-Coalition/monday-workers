// Verifies the JWT Monday puts in the Authorization header of a webhook delivery when the webhook
// was created by an app (issue #110): HS256, signed with that app's Signing Secret (Developer
// Center → the app → Basic Information). Webhooks created with a personal API token arrive
// unsigned, so this is a second factor next to the URL secret, not a replacement for it.
//
// Copied, not shared: donation-rollups and people-reclassification each hold a byte-identical
// src/mondayJwt.ts. Edit one, copy it to the other.
//
// The signature check is WebCrypto's HMAC verify, which compares in constant time. Only HS256 is
// accepted (no "none", no algorithm chosen by the token). exp, nbf and iat are checked when
// present, with CLOCK_SKEW_SECONDS of leeway. The token is never logged.

export type JwtFailure = 'missing' | 'malformed' | 'unsupported-alg' | 'bad-signature' | 'expired' | 'not-yet-valid';
export type JwtCheck = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: JwtFailure };

export const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;
const B64URL = /^[A-Za-z0-9_-]*$/;

function decodeB64url(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(segment) || segment.length % 4 === 1) return null;
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJsonObject(segment: string): Record<string, unknown> | null {
  const bytes = decodeB64url(segment);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyMondayJwt(authorization: string | undefined, signingSecret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<JwtCheck> {
  // Monday sends the bare token; a "Bearer " prefix is tolerated for hand replays.
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token === '') return { ok: false, reason: 'missing' };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJsonObject(headerPart);
  const claims = decodeJsonObject(payloadPart);
  const signature = decodeB64url(signaturePart);
  if (header === null || claims === null || signature === null) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'HS256') return { ok: false, reason: 'unsupported-alg' };

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${headerPart}.${payloadPart}`));
  if (!valid) return { ok: false, reason: 'bad-signature' };

  // Time claims only after the signature, so an unsigned token learns nothing from the answer.
  for (const name of ['exp', 'nbf', 'iat'] as const) {
    if (claims[name] !== undefined && typeof claims[name] !== 'number') return { ok: false, reason: 'malformed' };
  }
  const { exp, nbf, iat } = claims as { exp?: number; nbf?: number; iat?: number };
  if (exp !== undefined && nowSeconds > exp + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };
  if (nbf !== undefined && nowSeconds + CLOCK_SKEW_SECONDS < nbf) return { ok: false, reason: 'not-yet-valid' };
  if (iat !== undefined && nowSeconds + CLOCK_SKEW_SECONDS < iat) return { ok: false, reason: 'not-yet-valid' };
  return { ok: true, claims };
}

// The rollout policy, so a deploy ahead of the signing secret drops nothing:
//   no signing secret              → accept on the URL secret alone (verification off)
//   signing secret, no token       → accept, flagged 'missing' for the caller to log, until
//                                    `required` (MONDAY_WEBHOOK_JWT_REQUIRED=true) rejects it
//   signing secret, token present  → the token must verify, required or not
//   required, no signing secret    → reject everything (fail closed on a half-done config)
export interface MondayJwtPolicy {
  signingSecret?: string;
  required?: boolean;
}
export type JwtDecision =
  | { accept: true; verified: true }
  | { accept: true; verified: false; note: 'no-signing-secret' | 'missing' }
  | { accept: false; reason: JwtFailure | 'no-signing-secret' };

export async function checkMondayWebhookJwt(authorization: string | undefined, policy: MondayJwtPolicy, nowSeconds?: number): Promise<JwtDecision> {
  const secret = policy.signingSecret ?? '';
  if (secret === '') return policy.required ? { accept: false, reason: 'no-signing-secret' } : { accept: true, verified: false, note: 'no-signing-secret' };
  const check = await verifyMondayJwt(authorization, secret, nowSeconds);
  if (check.ok) return { accept: true, verified: true };
  if (check.reason === 'missing' && !policy.required) return { accept: true, verified: false, note: 'missing' };
  return { accept: false, reason: check.reason };
}

// MONDAY_WEBHOOK_JWT_REQUIRED is a plain var: exactly "true" turns it on, anything else is off.
export const jwtRequired = (value: string | undefined): boolean => value === 'true';
