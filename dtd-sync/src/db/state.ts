const WATERMARK_KEY = 'watermark';

/** ISO timestamp of the last successful DTD pull, or null before the first one. */
export async function getWatermark(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM sync_state WHERE key = ?').bind(WATERMARK_KEY).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setWatermark(db: D1Database, iso: string): Promise<void> {
  await db
    .prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(WATERMARK_KEY, iso)
    .run();
}
