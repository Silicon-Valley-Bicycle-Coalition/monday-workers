// Writes the outcome of a feedback-email send back onto the BP Request Form item, so staff can
// see a failed send on the board instead of it existing only in Worker logs. Optional: a config
// with `sendStatus: null` (the default until the board column and a Monday token exist) skips
// the write entirely, and the outcome is only logged.

const MONDAY_API_URL = 'https://api.monday.com/v2';
// Explicit pin (#39): Monday serves a deprecated version as the maintenance one, so a stale pin
// drifts silently. This Worker makes one call and carries no transport copy, so keep this in step
// with MONDAY_API_VERSION in the other Workers' src/monday/graphql.ts by hand.
const MONDAY_API_VERSION = '2026-07';
// Runs under ctx.waitUntil after the webhook has been answered; bound it so a hung Monday API
// can't keep the invocation alive indefinitely.
const MONDAY_TIMEOUT_MS = 10_000;

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
  token: string | undefined,
  itemId: number,
  outcome: SendOutcome
): Promise<void> {
  if (config === null) return;
  if (!token) {
    console.error(JSON.stringify({ event: 'bp-feedback-status-skipped', itemId, outcome, reason: 'MONDAY_API_TOKEN is not set' }));
    return;
  }
  const label = outcome === 'sent' ? config.sentLabel : config.failedLabel;
  try {
    const response = await fetch(MONDAY_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(MONDAY_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_API_VERSION },
      body: JSON.stringify({
        query: `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
          change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
        }`,
        variables: { boardId: config.boardId, itemId: String(itemId), columnId: config.columnId, value: label },
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as { data?: unknown; errors?: { message: string }[]; error_message?: string };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
    // Monday's rate-limit/auth-failure shape: HTTP 200, no data, no errors array.
    if (!json.data) throw new Error(json.error_message ?? 'response contained no data');
  } catch (error) {
    console.error(JSON.stringify({ event: 'bp-feedback-status-write-failed', itemId, outcome, label, error: errorMessage(error) }));
  }
}
