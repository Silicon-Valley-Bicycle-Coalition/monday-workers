import { describe, it, expect, vi } from 'vitest';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';
import { dueDigests, runDigest } from './run';
import { localTime } from './schedule';
import { FakeMonday, item } from '../test/fakeMonday';

const config = validateConfig(sandbox);
const at = (iso: string) => localTime(new Date(iso), config.timeZone);
const users = [
  { id: '68302743', email: 'felicia@bikesiliconvalley.org', enabled: true },
  { id: '68160704', email: 'clarrissa@bikesiliconvalley.org', enabled: true },
  { id: '68302747', email: 'gone@bikesiliconvalley.org', enabled: false },
];
const fakeEmail = () => ({ send: vi.fn().mockResolvedValue({ messageId: 'm1' }) });

describe('dueDigests', () => {
  it('sends the three Monday-morning digests at 08:00 Pacific and the unmatched check at 13:00', () => {
    expect(dueDigests(config, at('2026-10-26T15:00:00Z'))).toEqual(['recent-gifts', 'fiscal-year-by-size', 'last-week']);
    expect(dueDigests(config, at('2026-10-26T20:00:00Z'))).toEqual(['unmatched-gifts']);
    expect(dueDigests(config, at('2026-11-02T16:00:00Z'))).toEqual(['recent-gifts', 'fiscal-year-by-size', 'last-week']); // after DST ends
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
    expect(msg.to).toEqual(['clarrissa@bikesiliconvalley.org']);
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

  // #70: the digests carry donor data (names, gift amounts, giving), and production's EMAIL binding has no
  // allowed_destination_addresses (that would put staff addresses in this public repo).
  it('never emails an address outside recipientDomains, and raises it as an error by id', async () => {
    const email = fakeEmail();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outside = [
      { id: '68160704', email: 'outsider@gmail.com', enabled: true },
      { id: '68302747', email: 'Felicia@BikeSiliconValley.org', enabled: true },
      { id: '1', email: 'spoof@bikesiliconvalley.org.evil.com', enabled: true },
    ];
    const cfg = { ...config, digests: { ...config.digests, 'fiscal-year-by-size': { ...config.digests['fiscal-year-by-size'], recipients: [68160704, 68302747, 1] } } };
    const result = await runDigest({ monday: new FakeMonday([], [], outside), email, config: cfg }, 'fiscal-year-by-size', at('2026-10-26T15:00:00Z'));
    expect(result).toMatchObject({ sent: true, recipients: 1 });
    expect(email.send.mock.calls[0]![0].to).toEqual(['Felicia@BikeSiliconValley.org']);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('68160704, 1');
    expect(error.mock.calls[0]![0]).not.toContain('@');
    error.mockRestore();
  });

  it('throws rather than send when every recipient is outside recipientDomains', async () => {
    const email = fakeEmail();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const monday = new FakeMonday([], [], [{ id: '68302743', email: 'outsider2@gmail.com', enabled: true }]);
    await expect(runDigest({ monday, email, config }, 'renewals', at('2026-11-01T16:00:00Z'))).rejects.toThrow('no active recipients');
    expect(email.send).not.toHaveBeenCalled();
  });
});
