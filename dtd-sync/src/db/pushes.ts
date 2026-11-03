/** Mirror of a `pushes` row. */
export interface PushRow {
  mondayItemId: string;
  dtdIdentifier: string;
  state: 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
}

interface Row {
  monday_item_id: string;
  dtd_identifier: string;
  state: 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
}

// DTD error text can echo the donor's email back; the ledger must not keep it.
const EMAIL = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:]+/g;

export async function getPush(db: D1Database, mondayItemId: string): Promise<PushRow | null> {
  const r = await db.prepare('SELECT * FROM pushes WHERE monday_item_id = ?').bind(mondayItemId).first<Row>();
  return r
    ? { mondayItemId: r.monday_item_id, dtdIdentifier: r.dtd_identifier, state: r.state, attempts: r.attempts,
        lastError: r.last_error, sentAt: r.sent_at }
    : null;
}

/** Marks the item sent (clearing any earlier failure) and counts the attempt. */
export async function recordPush(db: D1Database, mondayItemId: string, dtdIdentifier: string, sentAtISO: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pushes (monday_item_id, dtd_identifier, state, attempts, last_error, sent_at)
       VALUES (?, ?, 'sent', 1, NULL, ?)
       ON CONFLICT(monday_item_id) DO UPDATE SET dtd_identifier = excluded.dtd_identifier, state = 'sent',
         attempts = pushes.attempts + 1, last_error = NULL, sent_at = excluded.sent_at`,
    )
    .bind(mondayItemId, dtdIdentifier, sentAtISO)
    .run();
}

/** Records a failed attempt; emails in `error` are replaced with `[email]` before storing. */
export async function recordPushFailure(db: D1Database, mondayItemId: string, dtdIdentifier: string, error: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pushes (monday_item_id, dtd_identifier, state, attempts, last_error, sent_at)
       VALUES (?, ?, 'failed', 1, ?, NULL)
       ON CONFLICT(monday_item_id) DO UPDATE SET dtd_identifier = excluded.dtd_identifier, state = 'failed',
         attempts = pushes.attempts + 1, last_error = excluded.last_error`,
    )
    .bind(mondayItemId, dtdIdentifier, error.replace(EMAIL, '[email]'))
    .run();
}
