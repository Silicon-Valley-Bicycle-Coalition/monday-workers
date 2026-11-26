// Eight digits, not six: a guesser gets `codeFailuresPerAddressDaily` wrong tries per address per
// day, and nothing caps tries across addresses but the per-IP limiter. With six digits a list of
// a few thousand donor addresses and a pool of IPs was a few percent a day of opening someone's
// portal; eight makes that a hundred times less likely.
export const CODE_LENGTH = 8;
const RANGE = 10 ** CODE_LENGTH;

// Largest multiple of RANGE that fits in a uint32. Values at or above it are rejected so the
// modulo doesn't favour the low codes.
const LIMIT = Math.floor(2 ** 32 / RANGE) * RANGE;

/** A uniformly random sign-in code of CODE_LENGTH digits, leading zeros kept. */
export function generateCode(): string {
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0]! >= LIMIT);
  return String(buffer[0]! % RANGE).padStart(CODE_LENGTH, '0');
}
