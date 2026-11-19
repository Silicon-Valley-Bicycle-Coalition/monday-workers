// Largest multiple of a million that fits in a uint32. Values at or above it are rejected so
// `% 1e6` doesn't favour the low codes.
const LIMIT = Math.floor(2 ** 32 / 1e6) * 1e6;

/** A uniformly random 6-digit sign-in code, leading zeros kept. */
export function generateCode(): string {
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0]! >= LIMIT);
  return String(buffer[0]! % 1e6).padStart(6, '0');
}
