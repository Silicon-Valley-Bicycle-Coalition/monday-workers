import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUsageCheck, type DailyUsage, type UsageAlertStore, type UsageTracking } from './usage';
import type { SkipContext } from './flags';

function fakeStore(init: { day: string; level: number } | null = null, tracking: UsageTracking | null = null) {
  const state = { last: init, tracking };
  const store: UsageAlertStore = {
    usageTracking: async () => state.tracking,
    saveUsageTracking: async (next) => {
      state.tracking = next;
    },
    lastUsageAlert: async () => state.last,
    recordUsageAlert: async (day, level) => {
      state.last = { day, level };
    },
  };
  return { store, state };
}

function usage(today: number, limit = 10_000, byUser: Record<string, number> = {}): DailyUsage {
  return {
    limit,
    byUser,
    lastUpdated: '2026-10-27T11:50:00.000Z',
    byDay: [
      { day: '2026-10-27', usage: today },
      { day: '2026-10-26', usage: 9_999 },
    ],
  };
}

function stubSlack() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  const texts = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).text as string);
  return { fetchMock, texts };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = new Date('2026-10-27T12:30:00.000Z');
const hook = 'https://hooks.example/webhook';

describe('runUsageCheck', () => {
  it('stays quiet below 50% of the daily limit', async () => {
    const { store, state } = fakeStore();
    const { fetchMock } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(4_999), store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.last).toBeNull();
  });

  it('alerts once at 50%, with today’s count and the limit', async () => {
    const { store, state } = fakeStore();
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(5_000), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('50%');
    expect(texts()[0]).toContain('5,000 of 10,000');
    expect(state.last).toEqual({ day: '2026-10-27', level: 50 });
  });

  it('does not repeat an alert at the same level on the same UTC day', async () => {
    const { store } = fakeStore({ day: '2026-10-27', level: 50 });
    const { fetchMock } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(7_000), store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escalates to 80% after a 50% alert the same day', async () => {
    const { store, state } = fakeStore({ day: '2026-10-27', level: 50 });
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(8_123), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('80%');
    expect(texts()[0]).toContain('8,123 of 10,000');
    expect(state.last).toEqual({ day: '2026-10-27', level: 80 });
  });

  it('jumps straight to 100% when the first check already finds it over, showing the real percent', async () => {
    const { store, state } = fakeStore();
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(23_940), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('passed 100%');
    expect(texts()[0]).toContain('239%');
    expect(state.last).toEqual({ day: '2026-10-27', level: 100 });
  });

  it('escalates from 80% to 100% the same day, then stays quiet', async () => {
    const { store, state } = fakeStore({ day: '2026-10-27', level: 80 });
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(10_000), store, slackWebhookUrl: hook, now: () => NOW });
    await runUsageCheck({ fetchUsage: async () => usage(30_000), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('passed 100%');
    expect(state.last).toEqual({ day: '2026-10-27', level: 100 });
  });

  it('alerts again on a new UTC day', async () => {
    const { store, state } = fakeStore({ day: '2026-10-26', level: 80 });
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(5_500), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()).toHaveLength(1);
    expect(state.last).toEqual({ day: '2026-10-27', level: 50 });
  });

  it('treats a day Monday has not reported yet as zero usage', async () => {
    const { store } = fakeStore();
    const { fetchMock } = stubSlack();
    const early = new Date('2026-10-28T00:30:00.000Z');
    await runUsageCheck({ fetchUsage: async () => usage(9_000), store, slackWebhookUrl: hook, now: () => early });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the total limit, so a purchased add-on raises the thresholds', async () => {
    const { store } = fakeStore();
    const { fetchMock } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(6_000, 20_000), store, slackWebhookUrl: hook, now: () => NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('under a dry run logs the alert as a skip line, sends nothing, and leaves it unsent', async () => {
    const { fetchMock } = stubSlack();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, state } = fakeStore();
    const dryRun: SkipContext = {
      worker: 'monday-backup', environment: 'production', mode: 'off', logLevel: 'normal', deliveryId: 'cron', piiKeys: [],
    };
    await runUsageCheck({ fetchUsage: async () => usage(5_000), store, slackWebhookUrl: hook, now: () => NOW, dryRun });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.last).toBeNull();
    const line = JSON.parse(log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('writeSwitch'))!);
    expect(line).toMatchObject({ writeSwitch: 'skipped', sink: 'Slack alert', operation: 'sendFailureAlert' });
  });
});

describe('who used today\'s calls', () => {
  const earlier = (over: Partial<UsageTracking> = {}): UsageTracking => ({
    day: '2026-10-27',
    since: '2026-10-27T00:30:00.000Z',
    totals: { 'Sandbox Integration': 300_000, 'SVBC Integration': 100_000 },
    today: {},
    ...over,
  });

  it('names the users whose 14-day totals grew today, biggest first', async () => {
    const { store } = fakeStore(null, earlier());
    const { texts } = stubSlack();
    const byUser = { 'SVBC Integration': 100_010, 'Sandbox Integration': 317_000 };
    await runUsageCheck({ fetchUsage: async () => usage(23_940, 10_000, byUser), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()[0]).toContain('Most calls since 00:30 UTC: Sandbox Integration 17,000; SVBC Integration 10.');
  });

  it('escapes a user name, so it cannot ping the channel or disguise a link', async () => {
    const { store } = fakeStore(null, earlier());
    const { texts } = stubSlack();
    const byUser = { '<!channel> & <https://evil.example|Help>': 9_000 };
    await runUsageCheck({ fetchUsage: async () => usage(9_000, 10_000, byUser), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()[0]).toContain('&lt;!channel&gt; &amp; &lt;https://evil.example|Help&gt; 9,000');
    expect(texts()[0]).not.toContain('<!channel>');
  });

  it('adds up across hourly checks, including quiet ones that send no alert', async () => {
    const { store, state } = fakeStore(null, earlier());
    const { texts } = stubSlack();
    const check = (today: number, sandbox: number) =>
      runUsageCheck({ fetchUsage: async () => usage(today, 10_000, { 'Sandbox Integration': sandbox }), store, slackWebhookUrl: hook, now: () => NOW });
    await check(1_000, 301_000);
    expect(texts()).toHaveLength(0);
    expect(state.tracking?.today).toEqual({ 'Sandbox Integration': 1_000 });
    await check(5_000, 305_000);
    expect(texts()[0]).toContain('Sandbox Integration 5,000.');
  });

  it('counts a total that shrank as zero: an old day just left Monday\'s window', async () => {
    const { store, state } = fakeStore(null, earlier());
    stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(10, 10_000, { 'Sandbox Integration': 250_000 }), store, slackWebhookUrl: hook, now: () => NOW });
    expect(state.tracking?.today).toEqual({});
    expect(state.tracking?.totals).toEqual({ 'Sandbox Integration': 250_000 });
  });

  it('starts over on a new UTC day, keeping the totals as the new baseline', async () => {
    const { store, state } = fakeStore(null, earlier({ day: '2026-10-26', today: { 'Sandbox Integration': 9_000 } }));
    stubSlack();
    const byUser = { 'Sandbox Integration': 310_000 };
    await runUsageCheck({ fetchUsage: async () => usage(10, 10_000, byUser), store, slackWebhookUrl: hook, now: () => NOW });
    expect(state.tracking).toEqual({ day: '2026-10-27', since: NOW.toISOString(), totals: byUser, today: {} });
  });

  it('says so when it has nothing to attribute yet', async () => {
    const { store } = fakeStore();
    const { texts } = stubSlack();
    await runUsageCheck({ fetchUsage: async () => usage(5_000, 10_000, { 'Sandbox Integration': 300_000 }), store, slackWebhookUrl: hook, now: () => NOW });
    expect(texts()[0]).toContain('No per-user figures yet today');
    expect(texts()[0]).not.toContain('300,000');
  });

  it('keeps tracking under a dry run, since only the Slack alert is gated', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, state } = fakeStore();
    stubSlack();
    const dryRun: SkipContext = {
      worker: 'monday-backup', environment: 'production', mode: 'off', logLevel: 'normal', deliveryId: 'cron', piiKeys: [],
    };
    await runUsageCheck({ fetchUsage: async () => usage(10, 10_000, { A: 1 }), store, slackWebhookUrl: hook, now: () => NOW, dryRun });
    expect(state.tracking?.totals).toEqual({ A: 1 });
  });
});
