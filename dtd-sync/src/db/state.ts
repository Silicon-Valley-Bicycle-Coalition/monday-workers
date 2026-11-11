const WATERMARK_KEY = 'watermark';
const REVIEW_SWEEP_KEY = 'pairing-review-sweep';

async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

/** ISO timestamp of the last successful DTD pull, or null before the first one. */
export const getWatermark = (db: D1Database): Promise<string | null> => getState(db, WATERMARK_KEY);
export const setWatermark = (db: D1Database, iso: string): Promise<void> => setState(db, WATERMARK_KEY, iso);

/** ISO timestamp of the last pairing run that re-evaluated Needs-review matches, or null before the first. */
export const getReviewSweep = (db: D1Database): Promise<string | null> => getState(db, REVIEW_SWEEP_KEY);
export const setReviewSweep = (db: D1Database, iso: string): Promise<void> => setState(db, REVIEW_SWEEP_KEY, iso);
