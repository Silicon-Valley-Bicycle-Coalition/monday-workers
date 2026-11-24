// What a failed EMAIL.send means for the gift. Codes: Cloudflare's Email Sending Workers API error
// table (developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-codes), 2026-11-24.

/**
 * - `rejected`: this email certainly didn't go. It costs the gift an attempt; other gifts still send.
 * - `stop`: nothing can be sent right now and it isn't this gift's fault. No attempt is spent.
 * - `unknown`: it may have gone. Never retried, and nothing more is sent this run.
 */
export type SendFailure = 'rejected' | 'stop' | 'unknown';

const REJECTED = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_CONTENT_TOO_LARGE',
  'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_DELIVERY_FAILED',
]);
const STOP = new Set([
  'E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_SENDER_DOMAIN_NOT_CONFIGURED', 'E_EMAIL_SENDING_NOT_READY',
  'E_RECIPIENT_PLAN_RESTRICTED', 'E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_ACCOUNT_SUSPENDED',
]);

export function sendErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E_[A-Z_]+$/.test(code) ? code : null;
}

export function classifySendError(err: unknown): SendFailure {
  const code = sendErrorCode(err);
  if (code !== null && REJECTED.has(code)) return 'rejected';
  if (code !== null && STOP.has(code)) return 'stop';
  // A malformed message throws a TypeError with no code, before anything is sent.
  if (code === null && err instanceof TypeError) return 'rejected';
  return 'unknown';
}
