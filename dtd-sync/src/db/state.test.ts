import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { getWatermark, setWatermark } from './state';

beforeEach(async () => { await env.DB.prepare('DELETE FROM sync_state').run(); });

describe('watermark', () => {
  it('is null until set', async () => {
    expect(await getWatermark(env.DB)).toBeNull();
  });
  it('round-trips and overwrites', async () => {
    await setWatermark(env.DB, '2026-01-01T00:00:00Z');
    expect(await getWatermark(env.DB)).toBe('2026-01-01T00:00:00Z');
    await setWatermark(env.DB, '2026-02-01T00:00:00Z');
    expect(await getWatermark(env.DB)).toBe('2026-02-01T00:00:00Z');
  });
});
