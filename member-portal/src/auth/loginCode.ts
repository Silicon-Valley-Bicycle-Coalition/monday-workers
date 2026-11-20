import { sha256Hex } from '../crypto/hash';

// Checks per request, across all of its rows.
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
// Checks per address per rolling 24 hours, across every browser.
export const LOGIN_CODE_DAILY_MAX = 10;
// The least time a failed POST /auth/code takes, so its response time can't tell an address on
// file from one that isn't (routes.ts).
export const LOGIN_CODE_MIN_FAILURE_MS = 500;

// Largest multiple of 10^6 below 2^32; draws at or above it are rejected so
// `% 1_000_000` stays uniform.
const REJECT_AT_OR_ABOVE = 4_294_000_000;

export function generateLoginCode(): string {
  const draw = new Uint32Array(1);
  do {
    crypto.getRandomValues(draw);
  } while (draw[0]! >= REJECT_AT_OR_ABOVE);
  return String(draw[0]! % 1_000_000).padStart(6, '0');
}

// Returns the six digits with all whitespace removed, or null if the input is not a code.
export function normalizeLoginCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const stripped = input.replace(/\s+/g, '');
  return /^[0-9]{6}$/.test(stripped) ? stripped : null;
}

// A request id is a generateToken() value: 64 lowercase hex characters.
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function hashLoginCode(requestId: string, code: string): Promise<string> {
  return sha256Hex(`${requestId}:${code}`);
}
