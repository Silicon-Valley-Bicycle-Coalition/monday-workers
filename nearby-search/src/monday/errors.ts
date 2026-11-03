// Which Monday failures are terminal (retrying can't help) — shared by the queue consumer and the
// geocode cron so both classify a failure the same way.
import { AmbiguousWriteError, MondayApiError } from './graphql';

// 4xx statuses that are not about the request itself, so they stay retryable: a rejected token or
// missing board access (fixing it heals the backlog) and the answers that recover with a wait.
// Same rule as funraise-sync/src/errors.ts.
const RETRYABLE_4XX = new Set([401, 403, 408, 409, 425, 429]);
// Monday's codes for a request rejected on its content, sent with HTTP 200 and an `errors` array
// (a deleted contact item is InvalidItemIdException). Same list as funraise-sync/src/errors.ts.
const MONDAY_TERMINAL_CODE =
  /^(ColumnValueException|CorrectedValueException|InvalidArgumentException|InvalidBoardIdException|InvalidColumnIdException|InvalidItemIdException|ItemNameTooLongException|RecordInvalidException|ResourceNotFoundException)$/;

export function isTerminal(err: unknown): err is MondayApiError {
  // A write that may have committed is never terminal: the retry's stale-claim check is what keeps
  // it from being created twice.
  if (!(err instanceof MondayApiError) || err instanceof AmbiguousWriteError) return false;
  const status = err.httpStatus;
  if (status !== undefined && status >= 400 && status < 500) return !RETRYABLE_4XX.has(status);
  return MONDAY_TERMINAL_CODE.test(err.code ?? '');
}
