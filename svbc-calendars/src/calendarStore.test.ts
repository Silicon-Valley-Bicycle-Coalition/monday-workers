import { env } from 'cloudflare:workers';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLastKnownGoodIcs,
  setLastKnownGoodIcs,
  getSourceStatus,
  recordSourceSuccess,
  recordSourceFailure,
  getAllSourceStatuses,
} from './calendarStore';

const KV = () => (env as unknown as { CALENDAR_KV: KVNamespace }).CALENDAR_KV;

describe('calendarStore', () => {
  beforeEach(async () => {
    const kv = KV();
    for (const key of ['ics:santa-clara', 'status:santa-clara', 'status:campbell']) {
      await kv.delete(key);
    }
  });

  it('round-trips the last-known-good ICS for a source', async () => {
    const kv = KV();
    expect(await getLastKnownGoodIcs(kv, 'santa-clara')).toBeNull();
    await setLastKnownGoodIcs(kv, 'santa-clara', 'BEGIN:VCALENDAR\nEND:VCALENDAR');
    expect(await getLastKnownGoodIcs(kv, 'santa-clara')).toBe('BEGIN:VCALENDAR\nEND:VCALENDAR');
  });

  it('defaults to a zeroed status when a source has never been recorded', async () => {
    const kv = KV();
    expect(await getSourceStatus(kv, 'santa-clara')).toEqual({ consecutiveFailures: 0, lastError: null, lastSuccessAt: null });
  });

  it('recordSourceSuccess resets the failure streak', async () => {
    const kv = KV();
    await recordSourceFailure(kv, 'santa-clara', 'boom');
    await recordSourceSuccess(kv, 'santa-clara', '2026-08-27T00:00:00.000Z');
    expect(await getSourceStatus(kv, 'santa-clara')).toEqual({ consecutiveFailures: 0, lastError: null, lastSuccessAt: '2026-08-27T00:00:00.000Z' });
  });

  it('recordSourceFailure increments the streak and returns the new count', async () => {
    const kv = KV();
    expect(await recordSourceFailure(kv, 'santa-clara', 'first failure')).toBe(1);
    expect(await recordSourceFailure(kv, 'santa-clara', 'second failure')).toBe(2);
    expect(await getSourceStatus(kv, 'santa-clara')).toEqual({ consecutiveFailures: 2, lastError: 'second failure', lastSuccessAt: null });
  });

  it('getAllSourceStatuses reads every requested source, defaulting missing ones', async () => {
    const kv = KV();
    await recordSourceFailure(kv, 'santa-clara', 'boom');
    const statuses = await getAllSourceStatuses(kv, ['santa-clara', 'campbell']);
    expect(statuses['santa-clara'].consecutiveFailures).toBe(1);
    expect(statuses['campbell']).toEqual({ consecutiveFailures: 0, lastError: null, lastSuccessAt: null });
  });
});
