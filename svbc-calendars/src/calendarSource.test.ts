import { env } from 'cloudflare:workers';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSourceCalendar } from './calendarSource';
import { getLastKnownGoodIcs, recordSourceFailure } from './calendarStore';
import type { LegistarSourceConfig, NormalizedEvent } from './types';

const KV = () => (env as unknown as { CALENDAR_KV: KVNamespace }).CALENDAR_KV;

const SOURCE: LegistarSourceConfig = { id: 'santa-clara', name: 'Santa Clara', committeeName: 'BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 };
const EVENT: NormalizedEvent = { sourceId: 'santa-clara', externalId: '1', title: 'BPAC', committeeName: 'BPAC', startUtc: '2026-11-04T03:00:00.000Z', endUtc: null, location: null, url: null };

describe('getSourceCalendar', () => {
  beforeEach(async () => {
    const kv = KV();
    await kv.delete('ics:santa-clara');
    await kv.delete('status:santa-clara');
  });

  it('on success, builds the ICS, stores it as last-known-good, and resets the failure streak', async () => {
    const kv = KV();
    const fetchSourceEvents = vi.fn(async () => [EVENT]);
    const sendFailureAlert = vi.fn();

    const result = await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert, slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(result.servedFromFallback).toBe(false);
    expect(result.ics).toContain('BEGIN:VCALENDAR');
    expect(await getLastKnownGoodIcs(kv, 'santa-clara')).toBe(result.ics);
    expect(sendFailureAlert).not.toHaveBeenCalled();
  });

  it('on failure with a stored fallback, serves the fallback and increments the streak', async () => {
    const kv = KV();
    await kv.put('ics:santa-clara', 'BEGIN:VCALENDAR\nEND:VCALENDAR');
    const fetchSourceEvents = vi.fn(async () => {
      throw new Error('legistar down');
    });
    const sendFailureAlert = vi.fn();

    const result = await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert, slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(result.servedFromFallback).toBe(true);
    expect(result.ics).toBe('BEGIN:VCALENDAR\nEND:VCALENDAR');
  });

  it('on failure with no stored fallback, returns a null ics', async () => {
    const kv = KV();
    const fetchSourceEvents = vi.fn(async () => {
      throw new Error('legistar down');
    });

    const result = await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert: vi.fn(), slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(result.ics).toBeNull();
    expect(result.servedFromFallback).toBe(false);
  });

  it('sends the Slack alert exactly when the failure streak first reaches 3', async () => {
    const kv = KV();
    await recordSourceFailure(kv, 'santa-clara', 'prior failure 1');
    await recordSourceFailure(kv, 'santa-clara', 'prior failure 2');
    const fetchSourceEvents = vi.fn(async () => {
      throw new Error('third failure');
    });
    const sendFailureAlert = vi.fn();

    await getSourceCalendar(SOURCE, { kv, fetchSourceEvents, sendFailureAlert, slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z') });

    expect(sendFailureAlert).toHaveBeenCalledWith('https://hooks.slack.com/x', 'santa-clara', 'Santa Clara', 3, 'third failure');
  });

  it('defers the success KV writes to waitUntil and serves without awaiting them', async () => {
    const kv = KV();
    const pending: Promise<unknown>[] = [];
    const result = await getSourceCalendar(SOURCE, { kv, fetchSourceEvents: vi.fn().mockResolvedValue([]), sendFailureAlert: vi.fn(), slackWebhookUrl: 'https://hooks.slack.com/x', now: () => new Date('2026-08-27T00:00:00Z'), waitUntil: (p) => pending.push(p) });
    expect(result.servedFromFallback).toBe(false);
    expect(pending).toHaveLength(1);
    expect(await getLastKnownGoodIcs(kv, SOURCE.id)).toBeNull();
    await Promise.all(pending);
    expect(await getLastKnownGoodIcs(kv, SOURCE.id)).toBe(result.ics);
  });
});
