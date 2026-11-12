// Per-item resend guard (#105), in D1 (migrations/0001_create_sends.sql). Anyone holding
// WEBHOOK_SECRET could otherwise loop the webhook over every BP Request item and re-email every
// organizer. Unlike the status-column check in feedbackItem.ts, this works with `sendStatus` null.
//
// A claim is taken before the send and kept on success. A failed send releases its own claim, so a
// genuine retry still goes out. If the isolate dies mid-send the claim stays until the cooldown
// ends: that errs toward not emailing twice.

/**
 * Atomically claims `itemId` for a send at `nowMs`. True when there's no claim yet or the last
 * one is at least `cooldownMs` old; false when the item was claimed within the cooldown. The
 * single upsert means two concurrent webhooks for one item can't both win.
 */
export async function claimSend(db: D1Database, itemId: number, nowMs: number, cooldownMs: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO sends (item_id, claimed_at) VALUES (?1, ?2)
       ON CONFLICT (item_id) DO UPDATE SET claimed_at = excluded.claimed_at
       WHERE sends.claimed_at <= ?3
       RETURNING item_id`,
    )
    .bind(itemId, nowMs, nowMs - cooldownMs)
    .first();
  return row !== null;
}

/** Drops the claim taken at `claimedAt` after a failed send. A newer claim is left alone. */
export async function releaseSend(db: D1Database, itemId: number, claimedAt: number): Promise<void> {
  await db.prepare('DELETE FROM sends WHERE item_id = ?1 AND claimed_at = ?2').bind(itemId, claimedAt).run();
}
