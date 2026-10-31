// Writes the outcome of a feedback-email send back onto the BP Request Form item, so staff can
// see a failed send on the board instead of it existing only in Worker logs. Optional: a config
// with `sendStatus: null` (the default until the board column and Monday access exist) skips
// the write entirely, and the outcome is only logged.

import { mondayRequest, type TokenProvider } from './mondayApi';

export interface SendStatusConfig {
  /** The board the webhook's items live on (BP Request Form, or its sandbox mirror). */
  boardId: string;
  /** A status column on that board. */
  columnId: string;
  /** Label written after a successful send, e.g. "Sent to Organizer". */
  sentLabel: string;
  /** Label written after a failed send, e.g. "Send Failed" — must exist on the column. */
  failedLabel: string;
}

export type SendOutcome = 'sent' | 'failed';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sets the configured status column to the outcome's label. Never throws: by the time this runs
 * the email has either gone out or definitely failed, and a write-back problem must not turn a
 * delivered email into a webhook error (which monday could retry into a duplicate send). Any
 * problem is logged instead.
 */
export async function writeSendStatus(
  config: SendStatusConfig | null,
  token: string | TokenProvider | undefined,
  itemId: number,
  outcome: SendOutcome
): Promise<void> {
  if (config === null) return;
  if (!token) {
    console.error(JSON.stringify({ event: 'bp-feedback-status-skipped', itemId, outcome, reason: 'neither MONDAY_AUTH nor MONDAY_API_TOKEN is set' }));
    return;
  }
  const label = outcome === 'sent' ? config.sentLabel : config.failedLabel;
  try {
    await mondayRequest(
      token,
      `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
      }`,
      { boardId: config.boardId, itemId: String(itemId), columnId: config.columnId, value: label },
    );
  } catch (error) {
    console.error(JSON.stringify({ event: 'bp-feedback-status-write-failed', itemId, outcome, label, error: errorMessage(error) }));
  }
}
