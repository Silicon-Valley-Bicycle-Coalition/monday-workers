import { redactText } from '../logSafe';

/** Mirror of a `prompts` row: one gift's post-gift matching email. */
export interface PromptRow {
  mondayItemId: string;
  donorItemId: string;
  variant: 'known' | 'ask';
  state: 'pending' | 'sent' | 'failed';
  attempts: number;
  giftDate: string;
  claimedAt: string;
  sentAt: string | null;
  mondayWrittenAt: string | null;
}

interface Row {
  monday_item_id: string;
  donor_item_id: string;
  variant: 'known' | 'ask';
  state: 'pending' | 'sent' | 'failed';
  attempts: number;
  gift_date: string;
  claimed_at: string;
  sent_at: string | null;
  monday_written_at: string | null;
}

const fromRow = (r: Row): PromptRow => ({
  mondayItemId: r.monday_item_id, donorItemId: r.donor_item_id, variant: r.variant, state: r.state, attempts: r.attempts,
  giftDate: r.gift_date, claimedAt: r.claimed_at, sentAt: r.sent_at, mondayWrittenAt: r.monday_written_at,
});

export async function getPrompt(db: D1Database, itemId: string): Promise<PromptRow | null> {
  const r = await db.prepare('SELECT * FROM prompts WHERE monday_item_id = ?').bind(itemId).first<Row>();
  return r ? fromRow(r) : null;
}

/**
 * True when this call owns the send: a new row, or a failed one with attempts left. One statement,
 * so two overlapping runs can't both get it. A pending or sent row is never reclaimed.
 */
export async function claimPrompt(
  db: D1Database,
  p: { itemId: string; donorItemId: string; variant: 'known' | 'ask'; giftDate: string; nowISO: string; maxAttempts: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO prompts (monday_item_id, donor_item_id, variant, state, attempts, gift_date, claimed_at)
       VALUES (?1, ?2, ?3, 'pending', 1, ?4, ?5)
       ON CONFLICT(monday_item_id) DO UPDATE SET donor_item_id = excluded.donor_item_id, variant = excluded.variant,
         state = 'pending', attempts = prompts.attempts + 1, gift_date = excluded.gift_date, claimed_at = excluded.claimed_at
       WHERE prompts.state = 'failed' AND prompts.attempts < ?6`,
    )
    .bind(p.itemId, p.donorItemId, p.variant, p.giftDate, p.nowISO, p.maxAttempts)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markPromptSent(db: D1Database, itemId: string, nowISO: string): Promise<void> {
  await db
    .prepare("UPDATE prompts SET state = 'sent', sent_at = ?, last_error = NULL WHERE monday_item_id = ?")
    .bind(nowISO, itemId)
    .run();
}

/** Records a failed send (never over a sent row); emails in `error` are replaced before storing. */
export async function markPromptFailed(db: D1Database, itemId: string, error: string): Promise<void> {
  await db
    .prepare("UPDATE prompts SET state = 'failed', last_error = ? WHERE monday_item_id = ? AND state = 'pending'")
    .bind(redactText(error), itemId)
    .run();
}

/** The Donations item now shows the prompt. */
export async function markPromptWritten(db: D1Database, itemId: string, nowISO: string): Promise<void> {
  await db.prepare('UPDATE prompts SET monday_written_at = ? WHERE monday_item_id = ?').bind(nowISO, itemId).run();
}

/** Whether this donor was emailed (or may have been: pending) about another gift at or after `sinceISO`. */
export async function donorPromptedSince(db: D1Database, donorItemId: string, exceptItemId: string, sinceISO: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS hit FROM prompts WHERE donor_item_id = ? AND monday_item_id <> ? AND state IN ('pending','sent') AND claimed_at >= ? LIMIT 1")
    .bind(donorItemId, exceptItemId, sinceISO)
    .first();
  return r !== null;
}

/** Sent prompts whose Donations write hasn't been confirmed. */
export async function unwrittenPrompts(db: D1Database): Promise<PromptRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM prompts WHERE state = 'sent' AND monday_written_at IS NULL ORDER BY sent_at, monday_item_id")
    .all<Row>();
  return results.map(fromRow);
}

/** Item ids still pending from before `beforeISO`: a run died between the claim and the result. */
export async function stuckPrompts(db: D1Database, beforeISO: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT monday_item_id FROM prompts WHERE state = 'pending' AND claimed_at < ? ORDER BY monday_item_id")
    .bind(beforeISO)
    .all<Pick<Row, 'monday_item_id'>>();
  return results.map((r) => r.monday_item_id);
}

/** Items emailed about whose gift date is in [startDate, endDate). */
export async function sentPromptsForGiftDates(db: D1Database, startDate: string, endDate: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT monday_item_id FROM prompts WHERE state = 'sent' AND gift_date >= ? AND gift_date < ? ORDER BY monday_item_id")
    .bind(startDate, endDate)
    .all<Pick<Row, 'monday_item_id'>>();
  return results.map((r) => r.monday_item_id);
}
