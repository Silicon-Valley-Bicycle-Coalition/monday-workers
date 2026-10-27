import { describe, it, expect, vi } from 'vitest';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';
import { dueDigests, runDigest } from './run';
import { localTime } from './schedule';
import { FakeMonday, item } from '../test/fakeMonday';

const config = validateConfig(sandbox);
const at = (iso: string) => localTime(new Date(iso), config.timeZone);
const users = [
  { id: '68302743', email: 'felicia@example.org', enabled: true },
  { id: '68160704', email: 'clarrissa@example.org', enabled: true },
  { id: '68302747', email: 'gone@example.org', enabled: false },
];
const fakeEmail = () => ({ send: vi.fn().mockResolvedValue({ messageId: 'm1' }) });

describe('dueDigests', () => {
  it('sends the three Monday-morning digests at 08:00 Pacific and the unmatched check at 13:00', () => {
    expect(dueDigests(config, at('2026-10-26T15:00:00Z'))).toEqual(['recent-gifts-wealth', 'fiscal-year-by-size', 'last-week']);
    expect(dueDigests(config, at('2026-10-26T20:00:00Z'))).toEqual(['unmatched-gifts']);
    expect(dueDigests(config, at('2026-11-02T16:00:00Z'))).toEqual(['recent-gifts-wealth', 'fiscal-year-by-size', 'last-week']); // after DST ends
    expect(dueDigests(config, at('2026-12-01T17:00:00Z'))).toEqual(['renewals']);
    expect(dueDigests(config, at('2026-10-27T15:00:00Z'))).toEqual([]);
  });
});

describe('runDigest', () => {
  it('skips an empty skipWhenEmpty digest unless forced', async () => {
    const email = fakeEmail();
    const deps = { monday: new FakeMonday([], [], users), email, config };
    expect(await runDigest(deps, 'unmatched-gifts', at('2026-10-26T20:00:00Z'))).toEqual({ key: 'unmatched-gifts', sent: false, reason: 'empty' });
    expect(email.send).not.toHaveBeenCalled();
    expect(await runDigest(deps, 'unmatched-gifts', at('2026-10-26T20:00:00Z'), { force: true })).toMatchObject({ sent: true, count: 0 });
  });

  it('sends an empty digest that is not skipWhenEmpty', async () => {
    const email = fakeEmail();
    await runDigest({ monday: new FakeMonday([], [], users), email, config }, 'renewals', at('2026-11-01T16:00:00Z'));
    expect(email.send).toHaveBeenCalledOnce();
  });

  it('emails only active recipients, from the configured sender', async () => {
    const email = fakeEmail();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monday = new FakeMonday([item('1', 'Gift', { amount: '25', date: '2026-10-20', status: 'Received' })], [], users);
    const result = await runDigest({ monday, email, config }, 'fiscal-year-by-size', at('2026-10-26T15:00:00Z'));
    expect(result).toEqual({ key: 'fiscal-year-by-size', sent: true, count: 1, recipients: 1 });
    const msg = email.send.mock.calls[0]![0];
    expect(msg.to).toEqual(['clarrissa@example.org']);
    expect(msg.from).toEqual({ email: config.fromAddress, name: config.fromName });
    expect(msg.subject).toBe('FY2027 to date: $25 from 1 gifts');
    expect(msg.html).toContain('$25');
    // The departed recipient is named by id, never by address.
    expect(warn.mock.calls[0]![0]).toContain('68302747');
    expect(warn.mock.calls[0]![0]).not.toContain('@');
    warn.mockRestore();
  });

  it('throws when no recipient is active', async () => {
    const monday = new FakeMonday([], [], []);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runDigest({ monday, email: fakeEmail(), config }, 'renewals', at('2026-11-01T16:00:00Z'))).rejects.toThrow('no active recipients');
  });
});
