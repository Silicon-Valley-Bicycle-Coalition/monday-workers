// D1 access for employer answers (spec "Storing it"). Only `pending` rows are changed by a later
// call; every other state is a decision the nightly run already made.

export type AnswerState = 'pending' | 'proposed' | 'skipped' | 'expired' | 'superseded';

export interface AnswerRow {
  source: string;
  sourceId: string;
  personItemId: string;
  answer: string;
  answerNormalized: string;
  answeredAt: string;
  context: string;
  state: AnswerState;
  orgItemId: string | null;
  receivedAt: string;
}

export interface AnswerKey { source: string; sourceId: string }

interface DbRow {
  source: string; source_id: string; person_item_id: string; answer: string; answer_normalized: string;
  answered_at: string; context: string; state: AnswerState; org_item_id: string | null; received_at: string;
}

const BATCH = 100;

// Inserts a new answer, or replaces a still-pending one (the guest corrected their registration).
// A row the run already decided on is left untouched and reported `closed`.
export async function upsertAnswer(
  db: D1Database,
  row: Omit<AnswerRow, 'state' | 'orgItemId'>,
): Promise<'inserted' | 'updated' | 'closed'> {
  const existing = await db.prepare('SELECT state FROM employer_answers WHERE source = ? AND source_id = ?')
    .bind(row.source, row.sourceId).first<{ state: AnswerState }>();
  if (existing && existing.state !== 'pending') return 'closed';
  const result = await db.prepare(
    `INSERT INTO employer_answers (source, source_id, person_item_id, answer, answer_normalized, answered_at, context, state, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(source, source_id) DO UPDATE SET
       person_item_id = excluded.person_item_id, answer = excluded.answer, answer_normalized = excluded.answer_normalized,
       answered_at = excluded.answered_at, context = excluded.context, received_at = excluded.received_at
     WHERE employer_answers.state = 'pending'`,
  ).bind(row.source, row.sourceId, row.personItemId, row.answer, row.answerNormalized, row.answeredAt, row.context, row.receivedAt).run();
  // A concurrent decision between the read and the write changes nothing.
  if ((result.meta.changes ?? 0) === 0) return 'closed';
  return existing ? 'updated' : 'inserted';
}

export async function pendingAnswers(db: D1Database): Promise<AnswerRow[]> {
  const { results } = await db.prepare(
    `SELECT source, source_id, person_item_id, answer, answer_normalized, answered_at, context, state, org_item_id, received_at
     FROM employer_answers WHERE state = 'pending' ORDER BY answered_at, received_at, source, source_id`,
  ).all<DbRow>();
  return results.map((r) => ({
    source: r.source, sourceId: r.source_id, personItemId: r.person_item_id, answer: r.answer, answerNormalized: r.answer_normalized,
    answeredAt: r.answered_at, context: r.context, state: r.state, orgItemId: r.org_item_id, receivedAt: r.received_at,
  }));
}

// `orgItemId` omitted leaves the stored value alone; null clears it.
export async function setAnswerStates(
  db: D1Database,
  updates: (AnswerKey & { state: AnswerState; orgItemId?: string | null })[],
  now: string,
): Promise<void> {
  const set = db.prepare(
    `UPDATE employer_answers SET state = ?, org_item_id = CASE WHEN ? THEN ? ELSE org_item_id END, last_tried_at = ?
     WHERE source = ? AND source_id = ?`,
  );
  for (let i = 0; i < updates.length; i += BATCH) {
    await db.batch(updates.slice(i, i + BATCH).map((u) =>
      set.bind(u.state, u.orgItemId === undefined ? 0 : 1, u.orgItemId ?? null, now, u.source, u.sourceId)));
  }
}

// Records that the nightly run tried to resolve these and left them pending.
export async function touchPending(db: D1Database, keys: AnswerKey[], now: string): Promise<void> {
  const touch = db.prepare("UPDATE employer_answers SET last_tried_at = ? WHERE source = ? AND source_id = ? AND state = 'pending'");
  for (let i = 0; i < keys.length; i += BATCH) {
    await db.batch(keys.slice(i, i + BATCH).map((k) => touch.bind(now, k.source, k.sourceId)));
  }
}
