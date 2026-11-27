import { describe, it, expect } from 'vitest';
import { decide, markSent, type SubjectState } from './state';

const T0 = new Date('2026-11-17T10:40:00Z');
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const state = (over: Partial<SubjectState> = {}): SubjectState => ({
  armedAt: '2026-11-10T00:00:00.000Z',
  bad: false,
  lastAlertAt: null,
  detail: null,
  ...over,
});
const bad = { ok: false as const, detail: 'no run since 2026-11-17T06:00:00.000Z' };

describe('decide', () => {
  it('first sight arms the subject and posts nothing even if unhealthy', () => {
    const d = decide('cron:funraise-sync:0 * * * *', bad, null, T0);
    expect(d.post).toBeNull();
    expect(d.next.armedAt).toBe(T0.toISOString());
  });

  it('going bad posts once', () => {
    const d = decide('cron:funraise-sync:0 * * * *', bad, state(), T0);
    expect(d.post?.kind).toBe('bad');
    expect(d.post?.text).toContain('funraise-sync');
    expect(d.post?.text).toContain(bad.detail);
    expect(d.next.bad).toBe(true);
  });

  it('staying bad posts a reminder only after 24 h', () => {
    const prev = state({ bad: true, lastAlertAt: T0.toISOString(), detail: bad.detail });
    expect(decide('writes:funraise-sync', bad, prev, hours(23)).post).toBeNull();
    expect(decide('writes:funraise-sync', bad, prev, hours(24)).post?.kind).toBe('reminder');
  });

  it('a bad subject whose alert never went out posts again next run', () => {
    const prev = state({ bad: true, lastAlertAt: null, detail: bad.detail });
    expect(decide('writes:funraise-sync', bad, prev, hours(1)).post?.kind).toBe('bad');
  });

  it('recovering posts once', () => {
    const prev = state({ bad: true, lastAlertAt: T0.toISOString(), detail: bad.detail });
    const d = decide('queue:funraise-sync-writes', { ok: true }, prev, hours(2));
    expect(d.post?.kind).toBe('recovered');
    expect(d.next.bad).toBe(false);
    expect(decide('queue:funraise-sync-writes', { ok: true }, d.next, hours(3)).post).toBeNull();
  });

  it('recovering before the bad alert ever went out posts nothing', () => {
    const prev = state({ bad: true, lastAlertAt: null, detail: bad.detail });
    const d = decide('writes:funraise-sync', { ok: true }, prev, hours(1));
    expect(d.post).toBeNull();
    expect(d.next.bad).toBe(false);
  });

  it('decide never sets lastAlertAt; only markSent does', () => {
    const d = decide('writes:funraise-sync', bad, state(), T0);
    expect(d.next.lastAlertAt).toBeNull();
    expect(markSent(d.next, T0).lastAlertAt).toBe(T0.toISOString());
  });
});

describe('decide with repostOnNewDetail', () => {
  const sent = state({ bad: true, lastAlertAt: T0.toISOString(), detail: 'unexpected route a/*' });
  const opts = { repostOnNewDetail: true };

  it('a changed detail posts again at once', () => {
    const d = decide('domains:example.org', { ok: false, detail: 'unexpected route a/*; unexpected route b/*' }, sent, hours(1), opts);
    expect(d.post?.kind).toBe('bad');
    expect(d.post?.text).toContain('b/*');
  });

  it('the same detail waits for the daily reminder', () => {
    expect(decide('domains:example.org', { ok: false, detail: 'unexpected route a/*' }, sent, hours(1), opts).post).toBeNull();
    expect(decide('domains:example.org', { ok: false, detail: 'unexpected route a/*' }, sent, hours(24), opts).post?.kind).toBe('reminder');
  });

  it('without the option a changed detail does not post', () => {
    expect(decide('queue:q', { ok: false, detail: 'other' }, sent, hours(1)).post).toBeNull();
  });
});
