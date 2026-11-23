// Cron events run at most once. Cloudflare occasionally delivers the same scheduled event a second
// time about 15 minutes after its scheduled time (seen on the long hourly run), and each run reads
// the whole Mailchimp audience and three Monday boards. The first invocation claims the event's
// (cron, scheduledTime) here; a later one finds the claim taken and skips. D1 is strongly
// consistent, so the INSERT is the lock; KV, which can be up to a minute stale, would not be.

export const CRON_RUN_RETENTION_MS = 7 * 86_400_000;

/** True when this invocation is the first for the event and should run. */
export async function claimCronEvent(db: D1Database, cron: string, scheduledTime: number, now: number = Date.now()): Promise<boolean> {
  const [, insert] = await db.batch([
    db.prepare(`DELETE FROM cron_runs WHERE claimed_at < ?1`).bind(now - CRON_RUN_RETENTION_MS),
    db.prepare(`INSERT INTO cron_runs (cron, scheduled_time, claimed_at) VALUES (?1, ?2, ?3) ON CONFLICT (cron, scheduled_time) DO NOTHING`)
      .bind(cron, scheduledTime, now),
  ]);
  return (insert!.meta.changes ?? 0) > 0;
}
