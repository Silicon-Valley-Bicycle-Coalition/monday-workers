import { AmbiguousWriteError, MondayApiError } from './monday/graphql';

// A failure that no retry can fix (GL#75, borrowed from quickbooks-sync/src/errors.ts): the upstream
// rejected the request itself, so the same request fails the same way on every one of the ~4 days
// of outage retries. The consumer records it on the row and acks the message instead of burning
// those retries into the DLQ. Fix the cause (usually the Monday item, column or config), then
// re-drive the row (README "Failures and the dead-letter queue").
export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

// The 4xx statuses that are NOT about the request itself, so they stay retryable: a rejected or
// unauthorized token (fixing the secret or the integration user's board access heals the whole
// backlog, which acking would drop — mailchimp-sync's rule too), and the timeout/conflict/rate
// answers that recover with a wait.
const RETRYABLE_4XX = new Set([401, 403, 408, 409, 425, 429]);

export function isTerminalHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);
}

// Monday's codes for a request it rejected on its content, sent with HTTP 200 and an `errors`
// array: a column value it won't take, a column, board or item id that doesn't exist. These are
// Monday's documented names, not all confirmed against the live API, so a miss only falls back to
// the ordinary retry-then-dead-letter path.
// UserUnauthorizedException is deliberately absent: it is also Monday's answer for a deleted
// board (README "Rebuilt boards"), which a config fix heals.
const MONDAY_TERMINAL_CODE =
  /^(ColumnValueException|CorrectedValueException|InvalidArgumentException|InvalidBoardIdException|InvalidColumnIdException|InvalidItemIdException|ItemNameTooLongException|RecordInvalidException|ResourceNotFoundException)$/;

export function isTerminalError(err: unknown): boolean {
  if (err instanceof TerminalError) return true;
  // A write that may have committed is never terminal: the retry is what runs the adopt-by-id
  // check that keeps it from being created twice.
  if (!(err instanceof MondayApiError) || err instanceof AmbiguousWriteError) return false;
  if (err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500) return isTerminalHttpStatus(err.httpStatus);
  return MONDAY_TERMINAL_CODE.test(err.code ?? '');
}
