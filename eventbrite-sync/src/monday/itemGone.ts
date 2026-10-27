import { MondayApiError } from './graphql';

// Monday's answer to a write against an item that no longer exists. The exact code is not yet
// confirmed against the live API (the code and message patterns below are Monday's documented
// names), so a miss here just falls back to the ordinary retry-then-dead-letter path.
export function isItemGone(err: unknown): boolean {
  if (!(err instanceof MondayApiError)) return false;
  return /ItemNotFound|InvalidItemId/i.test(err.code ?? '') || /item.{0,20}not found|inactive item/i.test(err.message);
}
